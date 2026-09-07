/**
 * Core data contracts for cache-refund.
 *
 * This file freezes two stable interfaces:
 *   {@link TurnEvent} — the parse output, produced by parse.ts and consumed
 *     by the renderer and the actions module.
 *   {@link Summary} — the `--json` schema, produced by parse.ts/analyze.ts
 *     and consumed by the renderer (render.ts), the actions module
 *     (baseline/recheck), and the documentation (METHODOLOGY.md).
 *
 * Both are intentionally self-describing: every derived number carries its
 * inputs or units so downstream renderers never have to re-derive.
 */

// -------------------------------------------------------------- parse output

/** Gap class of a turn relative to the previous usage turn in the same session. */
export type GapClass = "start" | "warm" | "recoverable" | "cold";
//  start       — first usage turn in the session (no previous turn)
//  warm        — gap <= 5m   (cache still hot; a re-warm here is cheap/expected)
//  recoverable — 5m < gap <= 60m  (the money bucket: 1h would have kept this warm)
//  cold        — gap > 60m    (cold either way; unfixable / informational)

/**
 * One usage-bearing assistant turn, after dedup by `message.id`.
 *
 * Field provenance (from the live JSONL, probed on the real corpus):
 *   ts       — top-level `timestamp` (ISO-8601), as epoch seconds (float).
 *   model    — `message.model` (e.g. "claude-opus-4-8"; may be a
 *              Bedrock/Vertex-prefixed id like "us.anthropic.claude-…" or
 *              the special "<synthetic>" no-charge model).
 *   sessionKey — file basename + ":" + `sessionId` (matches the oracle key).
 *   isSidechain — top-level `isSidechain` (subagent turns; TTL is configurable).
 *   c5 / c1  — `usage.cache_creation.ephemeral_{5m,1h}_input_tokens`.
 *              Fallback when `cache_creation` is absent or its 5m field is
 *              null: keep known c1 and put the remaining flat total in c5;
 *              mark the breakdown inferred.
 *   read     — `usage.cache_read_input_tokens`.
 *   compactBoundaryBefore — true when a `type:"system", subtype:"compact_boundary"`
 *              (or `isCompactSummary`) line immediately precedes this turn in the
 *              same session file. Used to exclude compaction rewrites from the
 *              recoverable leak bucket. Does NOT affect oracle-parity buckets.
 */
export interface TurnEvent {
  ts: number;
  model: string;
  sessionKey: string;
  isSidechain: boolean;
  c5: number;
  c1: number;
  /** Flat legacy counts were assigned to 5m for compatibility, not observed TTL evidence. */
  cacheTtlInferred?: boolean;
  read: number;
  compactBoundaryBefore: boolean;
  /** Best-effort project label (encoded-cwd dir name) for biggest-miss reporting. */
  project: string;
}

// -------------------------------------------------------------- the Summary

/** Which billing/TTL branch the user is in. Drives the verdict. */
export type Branch = "api-5m" | "api-1h" | "subscription" | "ambiguous";

/** TTL regime actually observed in the data (which write kind dominates). */
export type Regime = "5m" | "1h" | "none";

/** Per-model token + cost rollup. */
export interface ModelTotals {
  model: string;
  /** Base input $/MTok used for this model (after family fallback). */
  basePrice: number;
  /** True if the price came from a family fallback, not an exact id match. */
  priceFallback: boolean;
  /** True if the id is unknown AND carried non-zero billable tokens. */
  priceUnknown: boolean;
  creation5m: number;
  creation1h: number;
  read: number;
  /** Actual reconstructed $ for this model (writes at 1.25/2x + reads at 0.1x). */
  actualCost: number;
  turns: number;
}

/** One leak-table row. `dollars` is real $ for API branches, $-equivalent for subs. */
export interface LeakRow {
  cause:
    | "ttl-expiry-rewarm"
    | "cold-start"
    | "model-switch"
    | "compaction-rewrite"
    | "subagent-5m"
    | "subagent-1h";
  label: string;
  tokens: number;
  dollars: number;
  /** Share of total write spend (0..1). */
  shareOfWriteSpend: number;
  /** True for informational/unfixable rows (cold starts). */
  informational: boolean;
}

/** Raw gap-bucketed creation tokens + turn counts. Must match the oracle exactly. */
export interface GapBuckets {
  /** creation tokens, gap <= 5m */
  warm: number;
  /** creation tokens, 5m < gap <= 60m  (R) */
  recoverable: number;
  /** creation tokens, gap > 60m OR session start */
  cold: number;
  /** all creation tokens (C = warm + recoverable + cold) */
  creationTotal: number;
  /** reads that arrived after a 5-60m gap (R_read) */
  readsAfterRecoverableGap: number;
  /** turn counts per gap class (oracle keys: start, <=5m, 5-60m, >60m) */
  turnCounts: {
    start: number;
    warm: number;
    recoverable: number;
    cold: number;
  };
}

/** The symmetric, regime-aware counterfactual result. */
export interface Counterfactual {
  /** Actual reconstructed spend on cache writes+reads, all models, real $/$-eq. */
  actualCost: number;
  /** Hypothetical spend if every turn had been billed under 5m TTL. */
  cost5m: number;
  /** Hypothetical spend if every turn had been billed under 1h TTL. */
  cost1h: number;
  /**
   * delta = cost1h - cost5m  (negative => 1h is cheaper).
   * This is the sign-correct symmetric number, NOT the oracle's creation-only
   * delta. See `tailWriteEstimate` for the bounded approximation term.
   */
  delta1hMinus5m: number;
  /** Estimated incremental tail-write tokens added on the 1h side (bounded). */
  tailWriteTokens: number;
  /** $ value of the tail-write estimate (the documented oracle-vs-us gap). */
  tailWriteCost: number;
  /** delta normalized to a 30-day-equivalent window (delta / spanDays * 30). */
  delta30d: number;
  /** Observed span of the analyzed data, in days (for the 30d normalization). */
  spanDays: number;
}

/** Wrapped-insight candidate stats (the renderer ranks + renders these). */
export interface WrappedStats {
  /** Longest consecutive-day usage streak (days). */
  streakDays: number;
  /** Local hour (0-23) with the most turns, and that count. */
  peakHour: number;
  peakHourTurns: number;
  /** Session (key + project) with the most creation tokens, and the amount. */
  biggestSessionKey: string;
  biggestSessionProject: string;
  biggestSessionCreation: number;
  /** Total distinct local days with any activity. */
  activeDays: number;
}

/** The single most expensive recoverable re-warm event. */
export interface BiggestMiss {
  ts: number;
  isoTime: string;
  project: string;
  sessionKey: string;
  tokens: number;
  /** $ (or $-eq) the 1h TTL would have saved on this one re-warm. */
  dollars: number;
}

/** The worst single day by recoverable-leak $ total. */
export interface WorstDay {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  tokens: number;
  dollars: number;
}

/** TTL reality check: which regime the most-recent window actually received. */
export interface TtlRealityCheck {
  windowDays: number;
  regime: Regime;
  creation5m: number;
  creation1h: number;
  /** Human phrase, e.g. "1h" / "5m" / "no cache writes". */
  received: string;
}

export type SubagentTtl = "none" | "unknown" | "5m" | "1h" | "mixed";

export interface SubagentSummary {
  sessions: number;
  turns: number;
  /** Explicit TTL counters only; legacy flat counts have their own bucket. */
  creation5m: number;
  creation1h: number;
  creationUnknown: number;
  readTokens: number;
  /** Observed 5m writes after 5–60m pauses; a diagnostic, not proven waste. */
  pauseWriteTokens: number;
  recent: {
    windowDays: number;
    ttl: SubagentTtl;
    creation5m: number;
    creation1h: number;
    creationUnknown: number;
  };
}

/**
 * The full machine-readable summary. Stable, documented, versioned.
 * Every field the checkup rendering needs is present here so the renderer is
 * a pure function of this object.
 */
export interface Summary {
  /** Schema/version marker so downstream can detect shape drift. */
  summaryVersion: 1;
  /** Efficiency-score formula version (bumps when the formula changes). */
  scoreVersion: 1;

  /** Analysis window. */
  window: {
    mode: "days" | "all-time";
    days: number | null;
    /** Earliest / latest turn timestamps actually seen (epoch seconds). */
    firstTs: number | null;
    lastTs: number | null;
    spanDays: number;
  };

  scope: {
    /** null = all projects. */
    project: string | null;
    sessions: number;
    turns: number;
  };

  branch: Branch;
  /** Human-readable evidence bullets for the detected branch. */
  branchEvidence: string[];

  regime: Regime;
  ttlRealityCheck: TtlRealityCheck;
  /** Additive: child-only evidence, independent of the main TTL and billing branch. */
  subagents?: SubagentSummary;

  buckets: GapBuckets;

  tokens: {
    creationTotal: number;
    creation5m: number;
    creation1h: number;
    readTotal: number;
  };

  /** R/C and the 39.5% threshold. */
  recoverableRatio: number;
  threshold: number;
  /** true iff recoverableRatio > threshold (1h wins on a pure-5m pattern). */
  aboveThreshold: boolean;

  perModel: ModelTotals[];
  /** Model ids that were unknown AND carried non-zero billable tokens. */
  unknownModels: string[];

  leaks: LeakRow[];
  counterfactual: Counterfactual;

  /** 0-100 cache efficiency score. */
  efficiencyScore: number;

  biggestMiss: BiggestMiss | null;
  worstDay: WorstDay | null;
  wrapped: WrappedStats;

  /** Currency label: "USD" (API) or "USD-equivalent (API list rates)" (subs). */
  currency: string;
}
