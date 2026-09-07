/**
 * Policy cost models + all $-valued derivations.
 *
 * Every $ figure is computed per-turn at that turn's model price P (base input
 * $/MTok), then summed — never with a single blended rate. Multipliers:
 *   write5 = 1.25P, write1h = 2P, read = 0.1P.
 *
 * COUNTERFACTUAL (symmetric, regime-aware):
 *
 *   Actual cost  = Σ c5·1.25P + c1·2P + read·0.1P   (ground-truth reconstruction)
 *
 *   Counterfactual 1h (what a fully-1h world would bill), applied to 5m-regime
 *   turns; for turns already 1h it is ~ their actual:
 *     - warm (≤5m) creation: reprice writes at 2P
 *     - recoverable (5–60m) creation: converts to a READ at 0.1P PLUS an
 *       estimated incremental tail write at 2P (tail ≈ session median of
 *       warm-turn creation)
 *     - start / cold (>60m) creation: reprice at 2P
 *     - reads unchanged (0.1P)
 *
 *   Counterfactual 5m (what a fully-5m world would bill), applied to 1h-regime
 *   turns; for turns already 5m it is ~ their actual:
 *     - all creation reprices at 1.25P
 *     - recoverable (5–60m) READS convert to WRITES at 1.25P  (the re-warms a
 *       5m TTL would force but a 1h TTL currently absorbs)
 *     - start / cold reads unchanged
 *
 *   delta = cost1h − cost5m   (negative ⇒ 1h cheaper).
 *
 * DIFFERENCE VS ORACLE (documented, bounded): the oracle computes a
 * creation-only delta at a single flat price and does NOT (a) convert the
 * recoverable reads back to writes on the 5m side, nor (b) add the tail-write
 * term on the 1h side. Our delta therefore differs from the oracle's by exactly
 * those two corrections. The tail-write term is bounded by the warm-median
 * creation summed over recoverable turns (see `tailWriteTokens`).
 */

import {
  MULT_1H_WRITE,
  MULT_5M_WRITE,
  MULT_READ,
  priceForModel,
} from "./pricing.js";
import type { AnnotatedTurn } from "./analyze.js";
import type {
  BiggestMiss,
  Counterfactual,
  LeakRow,
  ModelTotals,
  TurnEvent,
  WorstDay,
  WrappedStats,
} from "./types.js";

const PER_MTOK = 1_000_000;

export interface PriceCtx {
  overrides?: Record<string, number>;
}

/** Cache of model -> resolved price to avoid repeated normalization. */
class PriceBook {
  private cache = new Map<string, ReturnType<typeof priceForModel>>();
  constructor(private overrides?: Record<string, number>) {}
  get(model: string) {
    let r = this.cache.get(model);
    if (!r) {
      r = priceForModel(model, this.overrides);
      this.cache.set(model, r);
    }
    return r;
  }
}

/** Per-turn base price P in $/token (not $/MTok). */
function pOf(book: PriceBook, ev: TurnEvent): number {
  return book.get(ev.model).base / PER_MTOK;
}

// ------------------------------------------------------------- per-model rollup

export function perModelTotals(
  annotated: AnnotatedTurn[],
  ctx: PriceCtx = {},
): { rows: ModelTotals[]; unknown: string[] } {
  const book = new PriceBook(ctx.overrides);
  const map = new Map<string, ModelTotals>();
  const unknown = new Set<string>();
  for (const { ev } of annotated) {
    const pr = book.get(ev.model);
    const P = pr.base / PER_MTOK;
    let row = map.get(ev.model);
    if (!row) {
      row = {
        model: ev.model,
        basePrice: pr.base,
        priceFallback: pr.fallback,
        priceUnknown: pr.unknown,
        creation5m: 0,
        creation1h: 0,
        read: 0,
        actualCost: 0,
        turns: 0,
      };
      map.set(ev.model, row);
    }
    row.creation5m += ev.c5;
    row.creation1h += ev.c1;
    row.read += ev.read;
    row.actualCost +=
      ev.c5 * MULT_5M_WRITE * P + ev.c1 * MULT_1H_WRITE * P + ev.read * MULT_READ * P;
    row.turns++;
    if (pr.unknown && ev.c5 + ev.c1 + ev.read > 0) unknown.add(ev.model);
  }
  const rows = [...map.values()].sort((a, b) => b.actualCost - a.actualCost);
  return { rows, unknown: [...unknown] };
}

// -------------------------------------------------------- tail-write estimate

/**
 * Session median of warm-turn creation, used as the incremental tail write a
 * 1h TTL would still pay after converting a recoverable re-warm into a read.
 * Bounded and small relative to the recoverable creation it replaces.
 */
function warmMedianBySession(annotated: AnnotatedTurn[]): Map<string, number> {
  const bucket = new Map<string, number[]>();
  for (const a of annotated) {
    if (a.gap === "warm" && a.creation > 0) {
      let arr = bucket.get(a.ev.sessionKey);
      if (!arr) {
        arr = [];
        bucket.set(a.ev.sessionKey, arr);
      }
      arr.push(a.creation);
    }
  }
  const med = new Map<string, number>();
  for (const [k, arr] of bucket) {
    arr.sort((x, y) => x - y);
    const mid = Math.floor(arr.length / 2);
    med.set(k, arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2);
  }
  return med;
}

// ------------------------------------------------------------- counterfactual

export function counterfactual(
  annotated: AnnotatedTurn[],
  spanDays: number,
  ctx: PriceCtx = {},
): Counterfactual {
  const book = new PriceBook(ctx.overrides);
  const warmMedian = warmMedianBySession(annotated);

  let actual = 0;
  let cost5m = 0;
  let cost1h = 0;
  let tailTokens = 0;
  let tailCost = 0;

  for (const a of annotated) {
    const ev = a.ev;
    const P = pOf(book, ev);
    const creation = a.creation;
    const w5 = MULT_5M_WRITE * P;
    const w1 = MULT_1H_WRITE * P;
    const rd = MULT_READ * P;

    // Actual reconstruction (ground truth).
    actual += ev.c5 * w5 + ev.c1 * w1 + ev.read * rd;

    // --- Counterfactual 5m: a fully-5m world.
    // All creation billed at 1.25P. Reads unchanged EXCEPT recoverable-gap
    // reads, which a 5m TTL would have to re-warm (convert read -> write).
    cost5m += creation * w5;
    if (a.gap === "recoverable") {
      cost5m += ev.read * w5; // re-warm the tokens 1h absorbed as a read
    } else {
      cost5m += ev.read * rd;
    }

    // --- Counterfactual 1h: a fully-1h world.
    // Recoverable creation becomes a read (0.1P) + a tail write (2P) sized at
    // the session warm-median (bounded). Other creation billed at 2P. Reads
    // unchanged at 0.1P.
    if (a.gap === "recoverable") {
      const tail = Math.min(warmMedian.get(ev.sessionKey) ?? 0, creation);
      tailTokens += tail;
      tailCost += tail * w1;
      cost1h += creation * rd + tail * w1;
    } else {
      cost1h += creation * w1;
    }
    cost1h += ev.read * rd;
  }

  const delta = cost1h - cost5m;
  const safeSpan = spanDays > 0 ? spanDays : 1;
  return {
    actualCost: actual,
    cost5m,
    cost1h,
    delta1hMinus5m: delta,
    tailWriteTokens: tailTokens,
    tailWriteCost: tailCost,
    delta30d: (delta / safeSpan) * 30,
    spanDays,
  };
}

// -------------------------------------------------------------------- leaks

/**
 * Leak table rows. `dollars` for each row is the recoverable/attributable $:
 * the amount that WOULD be saved (or is being wasted) by the fix, at per-model
 * rates. For TTL-expiry re-warms this is the 5m-write cost of the recoverable
 * creation minus what a 1h TTL would pay for it (read + tail) — i.e. the net
 * money the current-regime leak represents.
 *
 * Compaction-marked turns are excluded from ttl-expiry-rewarm (cold either way).
 * The subagent rows are informational write-spend breakdowns that overlap the
 * gap rows, not additional avoidable savings to add to them.
 */
export function leakRows(
  annotated: AnnotatedTurn[],
  totalWriteSpend: number,
  ctx: PriceCtx = {},
): LeakRow[] {
  const book = new PriceBook(ctx.overrides);
  const warmMedian = warmMedianBySession(annotated);

  let ttlTokens = 0;
  let ttlDollars = 0;
  let coldTokens = 0;
  let coldDollars = 0;
  let switchTokens = 0;
  let switchDollars = 0;
  let compactTokens = 0;
  let compactDollars = 0;
  let sideTokens = 0;
  let sideDollars = 0;
  let side1hTokens = 0;
  let side1hDollars = 0;

  for (const a of annotated) {
    const ev = a.ev;
    const P = pOf(book, ev);
    const creation = a.creation;
    const w5 = MULT_5M_WRITE * P;
    const w1 = MULT_1H_WRITE * P;
    const rd = MULT_READ * P;

    // Child TTL is configurable, including on subscriptions. Price the TTL
    // actually reported instead of charging every child write at the 5m rate.
    if (ev.isSidechain) {
      sideTokens += ev.c5;
      sideDollars += ev.c5 * w5;
      side1hTokens += ev.c1;
      side1hDollars += ev.c1 * w1;
    }

    // Model-switch invalidation: a creation spike where model changed.
    if (a.modelSwitch && creation > 0) {
      switchTokens += creation;
      switchDollars += creation * w5;
    }

    if (a.gap === "recoverable") {
      if (ev.compactBoundaryBefore) {
        // Compaction rewrite: excluded from the recoverable bucket (cold either
        // way). Attributed to its own row at write cost.
        compactTokens += creation;
        compactDollars += creation * w5;
      } else {
        // The recoverable TTL-expiry re-warm. Net leak = what 5m pays to
        // re-warm minus what a 1h TTL would pay (read + bounded tail write).
        const tail = Math.min(warmMedian.get(ev.sessionKey) ?? 0, creation);
        const netLeak = creation * w5 - (creation * rd + tail * w1);
        ttlTokens += creation;
        ttlDollars += Math.max(0, netLeak);
      }
    } else if (a.gap === "cold" || a.gap === "start") {
      coldTokens += creation;
      coldDollars += creation * w5;
    }
  }

  const share = (d: number) => (totalWriteSpend > 0 ? d / totalWriteSpend : 0);
  const rows: LeakRow[] = [
    {
      cause: "ttl-expiry-rewarm",
      label: "TTL-expiry re-warms (5–60m gaps)",
      tokens: ttlTokens,
      dollars: ttlDollars,
      shareOfWriteSpend: share(ttlDollars),
      informational: false,
    },
    {
      cause: "cold-start",
      label: "Session cold starts (>60m or session start)",
      tokens: coldTokens,
      dollars: coldDollars,
      shareOfWriteSpend: share(coldDollars),
      informational: true,
    },
    {
      cause: "model-switch",
      label: "Model-switch invalidations",
      tokens: switchTokens,
      dollars: switchDollars,
      shareOfWriteSpend: share(switchDollars),
      informational: false,
    },
    {
      cause: "compaction-rewrite",
      label: "Compaction rewrites",
      tokens: compactTokens,
      dollars: compactDollars,
      shareOfWriteSpend: share(compactDollars),
      informational: false,
    },
    {
      cause: "subagent-5m",
      label: "Subagent 5m overhead",
      tokens: sideTokens,
      dollars: sideDollars,
      shareOfWriteSpend: share(sideDollars),
      informational: true,
    },
  ];
  if (side1hTokens > 0) rows.push({
    cause: "subagent-1h", label: "Subagent 1h cache writes", tokens: side1hTokens,
    dollars: side1hDollars, shareOfWriteSpend: share(side1hDollars), informational: true,
  });
  return rows;
}

// --------------------------------------------------- biggest miss / worst day

/** Local-day key YYYY-MM-DD for an epoch-seconds timestamp. */
function dayKey(ts: number): string {
  const d = new Date(ts * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The single most expensive recoverable re-warm (net leak $), and the worst day
 * by total recoverable-leak $. Compaction-marked recoverable turns are excluded
 * (consistent with the leak table). Both use net-leak $ (5m write − 1h cost).
 */
export function biggestMissAndWorstDay(
  annotated: AnnotatedTurn[],
  ctx: PriceCtx = {},
): { biggestMiss: BiggestMiss | null; worstDay: WorstDay | null } {
  const book = new PriceBook(ctx.overrides);
  const warmMedian = warmMedianBySession(annotated);
  let biggest: BiggestMiss | null = null;
  const dayTokens = new Map<string, number>();
  const dayDollars = new Map<string, number>();

  for (const a of annotated) {
    if (a.gap !== "recoverable" || a.ev.compactBoundaryBefore) continue;
    const ev = a.ev;
    const P = pOf(book, ev);
    const creation = a.creation;
    const tail = Math.min(warmMedian.get(ev.sessionKey) ?? 0, creation);
    const netLeak = Math.max(
      0,
      creation * MULT_5M_WRITE * P - (creation * MULT_READ * P + tail * MULT_1H_WRITE * P),
    );
    if (netLeak <= 0) continue;

    if (!biggest || netLeak > biggest.dollars) {
      biggest = {
        ts: ev.ts,
        isoTime: new Date(ev.ts * 1000).toISOString(),
        project: ev.project,
        sessionKey: ev.sessionKey,
        tokens: creation,
        dollars: netLeak,
      };
    }
    const dk = dayKey(ev.ts);
    dayTokens.set(dk, (dayTokens.get(dk) ?? 0) + creation);
    dayDollars.set(dk, (dayDollars.get(dk) ?? 0) + netLeak);
  }

  let worstDay: WorstDay | null = null;
  for (const [day, dollars] of dayDollars) {
    if (!worstDay || dollars > worstDay.dollars) {
      worstDay = { day, tokens: dayTokens.get(day) ?? 0, dollars };
    }
  }
  return { biggestMiss: biggest, worstDay };
}

// ------------------------------------------------------------ wrapped stats

export function wrappedStats(annotated: AnnotatedTurn[]): WrappedStats {
  const days = new Set<string>();
  const hourTurns = new Array<number>(24).fill(0);
  const sessionCreation = new Map<string, { creation: number; project: string }>();

  for (const a of annotated) {
    const ev = a.ev;
    const d = new Date(ev.ts * 1000);
    days.add(dayKey(ev.ts));
    hourTurns[d.getHours()]++;
    const s = sessionCreation.get(ev.sessionKey) ?? { creation: 0, project: ev.project };
    s.creation += a.creation;
    sessionCreation.set(ev.sessionKey, s);
  }

  // Peak hour.
  let peakHour = 0;
  let peakHourTurns = 0;
  for (let h = 0; h < 24; h++) {
    if (hourTurns[h] > peakHourTurns) {
      peakHourTurns = hourTurns[h];
      peakHour = h;
    }
  }

  // Biggest session.
  let biggestSessionKey = "";
  let biggestSessionProject = "";
  let biggestSessionCreation = 0;
  for (const [key, v] of sessionCreation) {
    if (v.creation > biggestSessionCreation) {
      biggestSessionCreation = v.creation;
      biggestSessionKey = key;
      biggestSessionProject = v.project;
    }
  }

  // Longest consecutive-day streak.
  const sortedDays = [...days].sort();
  let streak = 0;
  let best = 0;
  let prev: number | null = null;
  for (const dstr of sortedDays) {
    const t = Date.parse(dstr + "T00:00:00");
    const dayNum = Math.round(t / 86400000);
    if (prev !== null && dayNum === prev + 1) streak++;
    else streak = 1;
    if (streak > best) best = streak;
    prev = dayNum;
  }

  return {
    streakDays: best,
    peakHour,
    peakHourTurns,
    biggestSessionKey,
    biggestSessionProject,
    biggestSessionCreation,
    activeDays: days.size,
  };
}

// -------------------------------------------------------------- efficiency

/**
 * Cache Efficiency Score (0–100): 100 × captured / (captured + avoidable leaks).
 *   captured        = $ value of cache reads actually served (the win) =
 *                     Σ read · 0.1P  (what you paid instead of full input) —
 *                     BUT the "captured value" is the SAVING vs re-paying input,
 *                     so we value captured as reads · (1 − 0.1)P = reads · 0.9P.
 *   avoidable leaks = net recoverable-rewarm $ + model-switch $ (both fixable),
 *                     valued at per-model rates. Cold starts and subagent
 *                     overhead are excluded (unfixable / informational).
 *
 * All terms are $-valued from billed tokens only. Bias: captured uses 0.9P as
 * the realized saving of a hit over a full re-read; avoidable uses net leak
 * (already tail-corrected). Documented in METHODOLOGY.md.
 */
export function efficiencyScore(
  annotated: AnnotatedTurn[],
  leaks: LeakRow[],
  ctx: PriceCtx = {},
): number {
  const book = new PriceBook(ctx.overrides);
  let captured = 0;
  for (const a of annotated) {
    const P = pOf(book, a.ev);
    captured += a.ev.read * (1 - MULT_READ) * P; // reads · 0.9P
  }
  let avoidable = 0;
  for (const l of leaks) {
    if (l.cause === "ttl-expiry-rewarm" || l.cause === "model-switch") {
      avoidable += l.dollars;
    }
  }
  const denom = captured + avoidable;
  if (denom <= 0) return 100;
  return Math.round(((100 * captured) / denom) * 10) / 10;
}
