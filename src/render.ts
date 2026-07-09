/**
 * The checkup renderer. Pure function of `Summary` — never recomputes a
 * number, only formats. render.ts owns the checkup sequence, in order:
 *
 *   trust line + live scan counter    (TTY only, update-in-place)
 *   CHECKUP header, ✓✓⚠ stagger        (TTY only, 150ms)
 *   THE NUMBER (efficiency score box)  <=57 cols, brandmark
 *   gap bars + verdict line
 *   YOUR CACHE, WRAPPED (3-5 insight lines)
 *   ending (recommender: consent prompt · validator: certificate · receipt)
 *   share rail
 *
 * Plus alternate render modes: card (score box + top Wrapped line), --md
 * (plain markdown, zero ANSI), --compact (~15 lines), --explain (formulas
 * with the user's own numbers substituted).
 *
 * Craft laws (pinned; do not change without re-verifying against the CLI's
 * terminal-output contract):
 *   - Never clear the screen (no \x1b[2J / \x1b[H anywhere in this file).
 *   - Non-TTY / CI -> plain ASCII (box chars, ✓/⚠/»/·/em-dash all swap to
 *     ASCII via format.ts's Sym table), no stagger, no in-place updates.
 *     --no-color is a NARROWER, separate switch: it strips ANSI color only
 *     and does NOT force ASCII symbols/box chars on an otherwise-real TTY
 *     (RenderOptions.noColor is independent of RenderOptions.tty; ascii-ness
 *     tracks tty-ness alone — see cli.ts's `makeSym(!tty)`). Both flags are
 *     decided once by cli.ts, up front.
 *   - The score box <= 57 cols (see format.ts box()).
 *   - Endings are deadpan. Loading-line puns are the trust line's job only,
 *     one max.
 */

import type { LeakRow, Summary } from "./types.js";
import {
  box,
  fmtBar,
  fmtBarAscii,
  fmtDollars,
  fmtPct,
  fmtTokens,
  fmtTokensCompact,
  makeInk,
  makeSym,
  type Ink,
  type Sym,
  wrapLine,
} from "./format.js";

export type EndingKind = "A-enable" | "A-revert" | "B" | "C";

export interface RenderOptions {
  /** TTY-ness, decided once by cli.ts (non-TTY => plain everything). */
  tty: boolean;
  /** Color forced off (--no-color), independent of TTY. */
  noColor?: boolean;
}

const BRAND = "cache-cash";
const METHODOLOGY_HINT = "methodology: npx @m8t-labs/cache-cash --explain";
/** Contains the `dot` decoration -> a function of `sym`, not a plain const. */
function shareHint(sym: Sym): string {
  return `share: npx @m8t-labs/cache-cash --compact  ${sym.dot}  #cachecash`;
}
/** Contains a prose em dash -> a function of `sym`, not a plain const. */
function watchTeaser(sym: Sym): string {
  return `watch (TTL regression alarm): coming in v1.1 ${sym.dash} watch the repo`;
}

/** Terminal-width law: no rendered line exceeds 80 cols at default terminal. */
const TERM_WIDTH = 80;

/**
 * Hard-wrap a prose line to TERM_WIDTH, breaking on spaces, with a hanging
 * indent on continuation lines so wrapped bullets/paragraphs stay legible.
 * Used for every free-text line in the terminal-rendered modes (renderFull,
 * card, compact) — NOT for --md (chat-client prose) or --explain (a
 * documentation dump), which are exempt from the terminal-width law.
 */
function wrapTerm(text: string, indent = ""): string[] {
  const width = TERM_WIDTH - indent.length;
  const segs = wrapLine(text, width);
  return segs.map((s, i) => (i === 0 ? s : indent + s));
}

/**
 * Currency-aware terse dollar formatter: on subscriber branches
 * (currency !== "USD") every waste/saving figure carries a "-eq" suffix —
 * including the space-constrained shared surfaces (card, --compact, WRAPPED
 * lines, the CHECKUP warning line) so they stay consistent with the
 * QUOTA-LEAK LIST, which already says "$X-eq" for the same figures. API
 * branches stay bare "$". The full "USD-equivalent (API list rates)" phrase
 * remains on the prose lines that already carry it (receipt headline,
 * vs-uncached, --md verdict); this helper is the terse form only.
 */
function fmtDollarsEq(s: Summary, n: number, decimals = 2): string {
  const base = fmtDollars(n, decimals);
  return s.currency === "USD" ? base : `${base}-eq`;
}

// ------------------------------------------------------------- ending logic

/**
 * Decide which of the four ending shapes to render. This is the renderer's
 * decision (not the analyzer's), per this branch table:
 *   api-5m + 1h wins (delta<0)      -> A-enable  (the recommender, positive case)
 *   api-5m + 5m already optimal     -> B          ("5m is optimal for you")
 *   api-1h + 1h wins (delta<0)      -> B          ("keeping 1h saves ~$X")
 *   api-1h + 5m would be cheaper    -> A-revert   (the validator, negative case)
 *   subscription                    -> C          (always; 1h is auto-active)
 *   ambiguous                       -> C shape w/ a notice (handled by caller;
 *                                      see renderAmbiguous)
 */
export function decideEnding(s: Summary): EndingKind {
  if (s.branch === "subscription") return "C";
  if (s.branch === "api-5m") {
    return s.counterfactual.delta1hMinus5m < 0 ? "A-enable" : "B";
  }
  if (s.branch === "api-1h") {
    return s.counterfactual.delta1hMinus5m < 0 ? "B" : "A-revert";
  }
  // ambiguous: caller (cli.ts) resolves via interactive question before
  // getting here in TTY mode; in --json mode we never render prose at all.
  return "C";
}

// -------------------------------------------------------------- trust line

/**
 * The trust line. The live scan counter itself is a CLI-owned stateful
 * loop (stdout.write with \r, TTY only) — render.ts only supplies the static
 * trust line text and the one-of-three loading pun, so cli.ts can drive the
 * update-in-place counter without this module knowing about timers.
 */
const LOADING_PUNS = [
  "counting cold hard cache…",
  "following the money…",
  "auditing the freezer…",
] as const;

export function pickLoadingPun(rand: () => number = Math.random): string {
  return LOADING_PUNS[Math.floor(rand() * LOADING_PUNS.length)];
}

export function trustLine(ink: Ink, sym: Sym): string {
  return ink.dim(`${BRAND} ${sym.dash} 100% local. Token counts + timestamps only. No content, no network.`);
}

export function scanCounterLine(filesScanned: number, filesTotal: number, pun: string, ink: Ink, sym: Sym): string {
  const pct = filesTotal > 0 ? Math.round((filesScanned / filesTotal) * 100) : 100;
  return ink.dim(`  scanning ${filesScanned}/${filesTotal} sessions (${pct}%) ${sym.dash} ${pun}`);
}

// ----------------------------------------------------------------- checkup

/** check/check/warn stagger lines. `staggerIndex` is which line is "revealed" so far (CLI drives the delay); render supplies all lines pre-built. */
export function checkupLines(s: Summary, ink: Ink, sym: Sym): string[] {
  const w = s.window;
  const windowLabel = w.mode === "all-time" ? "all-time" : `last ${w.days} days`;
  const lines: string[] = [];
  lines.push(ink.bold("CHECKUP"));
  lines.push(`  ${ink.green(sym.check)} scanned ${s.scope.sessions.toLocaleString()} sessions, ${s.scope.turns.toLocaleString()} turns (${windowLabel})`);
  lines.push(`  ${ink.green(sym.check)} TTL received (last ${s.ttlRealityCheck.windowDays}d): ${s.ttlRealityCheck.received}${s.ttlRealityCheck.regime !== "none" ? ` ${sym.check}` : ""}`);
  const leakWarn = s.leaks.find((l) => !l.informational && l.dollars > 0);
  if (leakWarn) {
    lines.push(`  ${ink.yellow(sym.warn)} ${shortLeakLabel(leakWarn.label).toLowerCase()}: ${fmtTokensCompact(leakWarn.tokens)} tokens (${fmtDollarsEq(s, leakWarn.dollars)})`);
  } else {
    lines.push(`  ${ink.green(sym.check)} no attributable leaks found this window`);
  }
  return lines;
}

// ------------------------------------------------------------- score box

/**
 * THE NUMBER: the <=57-col brandmarked score box. Also `card`'s top box.
 * Ending-aware: endings A/B lead with the efficiency score; ending C
 * (subscription receipt) leads with the $-equivalent 1h-vs-5m receipt figure
 * — the receipt's headline number — with the score as the second line. The
 * ending kind is derived internally from the Summary (decideEnding) so
 * callers' signatures are unchanged.
 */
export function numberBox(s: Summary, ink: Ink, sym: Sym): string {
  const kind = decideEnding(s);
  const score = s.efficiencyScore.toFixed(1);

  if (kind === "C") {
    const delta = s.counterfactual.delta1hMinus5m;
    // Box-safe short form of the receipt headline; "-eq" is the box-width
    // currency marker (full "USD-equivalent (API list rates)" is prose-only).
    const fig =
      delta < 0
        ? `saved ~${fmtDollars(Math.abs(delta))}-eq vs 5m (${windowLabelShort(s)})`
        : `~${fmtDollars(delta)}-eq costlier than 5m (${windowLabelShort(s)})`;
    const figColor = delta < 0 ? ink.green : ink.yellow;
    return box(
      [
        { text: ink.dim(BRAND) },
        { text: "" },
        { text: "YOUR 1H CACHE RECEIPT" },
        { text: figColor(ink.bold(fig)) },
        { text: "" },
        { text: ink.dim(`efficiency score: ${score} / 100`) },
      ],
      sym.ascii,
    );
  }

  const scoreColor = s.efficiencyScore >= 90 ? ink.green : s.efficiencyScore >= 70 ? ink.yellow : ink.red;
  return box(
    [
      { text: ink.dim(BRAND) },
      { text: "" },
      { text: "CACHE EFFICIENCY SCORE" },
      { text: scoreColor(ink.bold(`${score} / 100`)) },
      { text: "" },
      { text: ink.dim(scoreLabel(s.efficiencyScore, sym, kind)) },
    ],
    sym.ascii,
  );
}

/**
 * Human label for a score band. "certified optimal" is EXCLUSIVELY ending
 * B's label — a high score on any other ending gets a neutral "excellent"
 * (A endings still have an actionable fix; C's box doesn't use this label at
 * all).
 */
function scoreLabel(score: number, sym: Sym, kind: EndingKind): string {
  if (score >= 95) return kind === "B" ? "certified optimal" : "excellent";
  if (score >= 80) return `solid ${sym.dash} a few leaks worth a look`;
  if (score >= 50) return "leaking real money";
  return "leaking a lot of money";
}

// ---------------------------------------------------------------- gap bars

/** Gap bars: warm/recoverable/cold as proportion of creation, plus the R/C verdict line. */
export function gapBars(s: Summary, ink: Ink, useAscii: boolean, sym: Sym): string[] {
  const b = s.buckets;
  const total = b.creationTotal > 0 ? b.creationTotal : 1;
  const bar = useAscii ? fmtBarAscii : fmtBar;
  const row = (label: string, tokens: number, color: (x: string) => string) =>
    `  ${label.padEnd(12)} ${color(bar(tokens / total, 20))} ${fmtPct(tokens / total).padStart(6)}  ${fmtTokensCompact(tokens)}`;
  const lines = [
    ink.bold("GAP BREAKDOWN (cache-write tokens by re-warm gap)"),
    row("warm (<=5m)", b.warm, ink.green),
    row("recoverable", b.recoverable, ink.yellow),
    row("cold (>60m)", b.cold, ink.dim),
  ];
  lines.push("");
  lines.push(verdictLine(s, ink, sym));
  return lines;
}

export function verdictLine(s: Summary, ink: Ink, sym: Sym): string {
  const pctR = fmtPct(s.recoverableRatio);
  const pctThresh = fmtPct(s.threshold);
  const cf = s.counterfactual;
  if (s.branch === "subscription") {
    return ink.bold(`R/C = ${pctR} recoverable (break-even ${pctThresh}) ${sym.dash} 1h is already yours ${sym.check}`);
  }
  if (cf.delta1hMinus5m < 0) {
    return ink.bold(
      `R/C = ${pctR} > break-even ${pctThresh} ${sym.dash} switching to 1h saves ~${fmtDollars(Math.abs(cf.delta30d))}/30d`,
    );
  }
  return ink.bold(
    `R/C = ${pctR} <= break-even ${pctThresh} ${sym.dash} 1h would cost ~${fmtDollars(Math.abs(cf.delta30d))}/30d MORE`,
  );
}

// ------------------------------------------------------------- cache wrapped

/**
 * "Your Cache, Wrapped": 3-5 insight lines ranked by extremity. Every line
 * carries a number. Sourced ONLY from Summary fields the analyzer actually
 * attributes (wrapped stats, leak rows, biggestMiss, worstDay) — never a
 * cause the analyzer can't compute (no /resume lines: that data isn't
 * something the analyzer attributes). biggestMiss/worstDay may be null
 * (empty corpus) — guarded out, not padded.
 */
export function wrappedLines(s: Summary, ink: Ink, sym: Sym): string[] {
  interface Candidate {
    extremity: number; // sort key, higher = more extreme/interesting
    text: string;
  }
  const w = s.wrapped;
  const cands: Candidate[] = [];

  if (s.biggestMiss) {
    const m = s.biggestMiss;
    cands.push({
      extremity: m.dollars * 1000, // dollars dominate ranking; biggest single event first
      text: `Your biggest single miss: a ${fmtTokensCompact(m.tokens)}-token re-warm in ${shortProject(m.project)} ${sym.dash} ${fmtDollarsEq(s, m.dollars)} in one turn.`,
    });
  }
  if (s.worstDay) {
    const d = s.worstDay;
    cands.push({
      extremity: d.dollars * 900,
      text: `Worst day: ${d.day} leaked ${fmtDollarsEq(s, d.dollars)} (${fmtTokensCompact(d.tokens)} tokens) to expired cache.`,
    });
  }
  if (w.streakDays >= 3) {
    cands.push({
      extremity: w.streakDays * 50,
      text: `You've used Claude Code ${w.streakDays} days in a row (${w.activeDays} active days this window).`,
    });
  }
  if (w.peakHourTurns > 0) {
    cands.push({
      extremity: w.peakHourTurns * 10,
      text: `Your peak hour is ${String(w.peakHour).padStart(2, "0")}:00 ${sym.dash} ${w.peakHourTurns.toLocaleString()} turns, more than any other hour.`,
    });
  }
  if (w.biggestSessionCreation > 0) {
    cands.push({
      extremity: w.biggestSessionCreation / 1000,
      text: `Your biggest session wrote ${fmtTokensCompact(w.biggestSessionCreation)} tokens of cache in ${shortProject(w.biggestSessionProject)}.`,
    });
  }
  const modelSwitch = s.leaks.find((l) => l.cause === "model-switch");
  if (modelSwitch && modelSwitch.dollars > 0) {
    cands.push({
      extremity: modelSwitch.dollars * 800,
      text: `Model switches invalidated ${fmtTokensCompact(modelSwitch.tokens)} tokens of cache (${fmtDollarsEq(s, modelSwitch.dollars)}).`,
    });
  }
  const compaction = s.leaks.find((l) => l.cause === "compaction-rewrite");
  if (compaction && compaction.dollars > 0) {
    cands.push({
      extremity: compaction.dollars * 700,
      text: `Compaction rewrites cost ${fmtDollarsEq(s, compaction.dollars)} across ${fmtTokensCompact(compaction.tokens)} tokens this window.`,
    });
  }

  cands.sort((a, b) => b.extremity - a.extremity);
  const top = cands.slice(0, 5);
  const lines = [ink.bold("YOUR CACHE, WRAPPED")];
  if (top.length === 0) {
    lines.push(`  Not enough data yet ${sym.dash} run a few more sessions and check back.`);
    return lines;
  }
  for (const c of top) {
    const [first, ...rest] = wrapTerm(c.text, "    ");
    lines.push(`  ${ink.cyan(sym.bullet)} ${first}`);
    lines.push(...rest);
  }
  return lines;
}

function shortProject(project: string): string {
  if (!project) return "an unlabeled project";
  // encoded-cwd dirs look like "-Users-name-dev-foo"; take the last 1-2 segments.
  const parts = project.split("-").filter(Boolean);
  return parts.slice(-2).join("-") || project;
}

/**
 * Shorten the (long, `LeakRow.label`) descriptions to fit narrow terminal
 * rows (CHECKUP's warning line, the receipt's quota-leak list). Keeps the
 * same `cause` semantics, just fewer words — never changes meaning.
 */
function shortLeakLabel(label: string): string {
  const MAP: Record<string, string> = {
    "TTL-expiry re-warms (5–60m gaps)": "TTL-expiry re-warms",
    "Session cold starts (>60m or session start)": "Session cold starts",
    "Model-switch invalidations": "Model-switch invalidations",
    "Compaction rewrites": "Compaction rewrites",
    "Subagent 5m overhead": "Subagent 5m overhead",
  };
  return MAP[label] ?? label;
}

// ------------------------------------------------------------------ ending

export interface EndingRender {
  lines: string[];
  /** true if this ending needs a [y/N] prompt (cli.ts owns the actual readline). */
  needsConsent: boolean;
  consentVerb?: "enable" | "revert";
}

export function renderEnding(s: Summary, kind: EndingKind, ink: Ink, sym: Sym): EndingRender {
  switch (kind) {
    case "A-enable":
      return endingEnable(s, ink, sym);
    case "A-revert":
      return endingRevert(s, ink, sym);
    case "B":
      return endingCertified(s, ink, sym);
    case "C":
      return endingReceipt(s, ink, sym);
  }
}

function endingEnable(s: Summary, ink: Ink, sym: Sym): EndingRender {
  const cf = s.counterfactual;
  const lines = [
    ink.bold("THE FIX"),
    "",
    ...wrapTerm(
      `You're on the 5-minute cache TTL. Your recoverable ratio (${fmtPct(s.recoverableRatio)}) is above the ${fmtPct(s.threshold)} break-even ${sym.dash} switching to the 1-hour TTL saves ~${fmtDollars(Math.abs(cf.delta30d))}/30d (~${fmtDollars(Math.abs(cf.delta1hMinus5m))} over the ${Math.round(cf.spanDays)}-day window analyzed).`,
    ),
    "",
    ink.dim("  diff:"),
    ink.dim('    "env": { "ENABLE_PROMPT_CACHING_1H": "1" }'),
    "",
    ...wrapTerm("This edits ~/.claude/settings.json (backed up first). Applies to new sessions only."),
  ];
  return { lines, needsConsent: true, consentVerb: "enable" };
}

function endingRevert(s: Summary, ink: Ink, sym: Sym): EndingRender {
  const cf = s.counterfactual;
  const lines = [
    ink.bold("THE FIX"),
    "",
    ...wrapTerm(
      `You're on the 1-hour cache TTL, but your recoverable ratio (${fmtPct(s.recoverableRatio)}) is below the ${fmtPct(s.threshold)} break-even for your pattern ${sym.dash} 5m would cost ~${fmtDollars(Math.abs(cf.delta30d))}/30d less (~${fmtDollars(Math.abs(cf.delta1hMinus5m))} over the ${Math.round(cf.spanDays)}-day window analyzed).`,
    ),
    "",
    ink.dim("  diff:"),
    ink.dim('    remove "ENABLE_PROMPT_CACHING_1H", or set "FORCE_PROMPT_CACHING_5M": "1"'),
    "",
    ...wrapTerm("This edits ~/.claude/settings.json (backed up first). Applies to new sessions only."),
  ];
  return { lines, needsConsent: true, consentVerb: "revert" };
}

function endingCertified(s: Summary, ink: Ink, sym: Sym): EndingRender {
  const cf = s.counterfactual;
  const onWhat = s.branch === "api-1h" ? "1h" : "5m";
  const cachingDelta = uncachedCost(s) - cf.actualCost;
  // Box-safe short form (a single centered 57-col row can't hold the longer
  // "cost you $X MORE than uncached" sentence — see cachingSavedLine below
  // for the full honest wording used outside the box).
  const cachingBoxLine =
    cachingDelta >= 0
      ? `caching saved you ${fmtDollars(cachingDelta)} vs uncached`
      : `caching cost ${fmtDollars(Math.abs(cachingDelta))} more than uncached`;
  const certBox = box(
    [
      { text: ink.dim(BRAND) },
      { text: "" },
      { text: ink.green(ink.bold(`CERTIFIED OPTIMAL ${sym.check}`)) },
      { text: "" },
      { text: `score: ${s.efficiencyScore.toFixed(1)} / 100` },
      { text: cachingBoxLine },
      { text: ink.dim(`you're on ${onWhat} ${sym.dash} the cheaper TTL for your pattern`) },
    ],
    sym.ascii,
  );
  const verdict =
    s.branch === "api-1h"
      ? `Keeping the 1-hour TTL saves ~${fmtDollars(Math.abs(cf.delta30d))}/30d vs the 5-minute default for your pattern.`
      : `The 5-minute TTL is already optimal for your pattern ${sym.dash} switching to 1h would cost ~${fmtDollars(Math.abs(cf.delta30d))}/30d more.`;
  const lines = [certBox, "", ...wrapTerm(verdict), ...wrapTerm(proofLine(s))];
  return { lines, needsConsent: false };
}

function proofLine(s: Summary): string {
  const cf = s.counterfactual;
  return `proof: actual ${fmtDollars(cf.actualCost)} vs 5m-world ${fmtDollars(cf.cost5m)} vs 1h-world ${fmtDollars(cf.cost1h)}, over ${Math.round(cf.spanDays)}d.`;
}

/**
 * Hypothetical spend if prompt caching didn't exist at all: every cache-write
 * AND cache-read token instead billed as a fresh, full-price input token
 * (1x base P), summed per-model at that model's own basePrice — never a
 * blended rate, matching the rest of the cost math. NOT provided by Summary
 * directly (Counterfactual only carries cost5m/cost1h, both still-cached
 * worlds under a different TTL); derived here as a straight linear
 * recombination of `perModel[]`'s already-computed token totals, so this is
 * formatting/aggregation, not re-deriving analyzer math (gap classes, leak
 * attribution, etc. are untouched). Used by the "caching saved you $X vs
 * uncached" line required on endings B and C.
 */
function uncachedCost(s: Summary): number {
  let total = 0;
  for (const m of s.perModel) {
    const P = m.basePrice / 1_000_000;
    total += (m.creation5m + m.creation1h + m.read) * P;
  }
  return total;
}

/**
 * "Caching saved you $X vs uncached" — but honestly: for a write-heavy,
 * read-light access pattern (small/synthetic corpora especially), caching
 * CAN cost more than not caching at all (every write pays a 1.25x/2x markup;
 * that markup is only recouped by later 0.1x reads, and if the cache is
 * rarely read back the markup never gets paid off). Never claim a "$-2.41
 * saved" — flip the sentence honestly instead of printing a negative saving.
 */
function cachingSavedLine(s: Summary, sym: Sym): string {
  const cf = s.counterfactual;
  const delta = uncachedCost(s) - cf.actualCost;
  if (delta >= 0) {
    return `Caching saved you ${fmtDollars(delta)} ${s.currency} vs uncached this window.`;
  }
  return `Caching cost you ${fmtDollars(Math.abs(delta))} ${s.currency} MORE than uncached this window (write-heavy, read-light pattern ${sym.dash} the cache markup isn't being recouped by reads).`;
}

/**
 * Share of cache-write tokens billed at the 1h TTL over the ANALYZED window
 * (Summary.tokens, not the 7d ttlRealityCheck window):
 * creation1h / (creation1h + creation5m). This is the number the receipt's
 * "verified in your transcripts: N% of writes are 1h" line shows — NOT
 * recoverableRatio (R/C), which is a gap-bucket ratio unrelated to TTL share.
 * These two must not be conflated: on this machine's corpus they differ
 * decisively (~99.5% share vs R/C's 13.7%).
 */
function oneHourWriteShare(s: Summary): number {
  const denom = s.tokens.creation1h + s.tokens.creation5m;
  return denom > 0 ? s.tokens.creation1h / denom : 0;
}

/**
 * Window label for the receipt's counterfactual headline. Two-deltas rule:
 * `delta1hMinus5m` covers the SELECTED window and must be labeled with that
 * window — never with "/30d" (that's delta30d's label).
 */
function windowLabel(s: Summary): string {
  return s.window.mode === "days" && s.window.days != null
    ? `in the last ${s.window.days} days`
    : `over the ${Math.round(s.counterfactual.spanDays)}-day span analyzed`;
}

/** Short window label for the 57-col receipt score box. */
function windowLabelShort(s: Summary): string {
  return s.window.mode === "days" && s.window.days != null
    ? `last ${s.window.days}d`
    : `${Math.round(s.counterfactual.spanDays)}d span`;
}

/**
 * The subscriber receipt's LEAD line: the 1h-vs-5m counterfactual from
 * delta1hMinus5m (negative = 1h saved money), labeled with its window. The
 * vs-uncached line is deliberately SECOND — it's the bigger number but the
 * less pointed comparison; the 5m-world delta is the receipt's actual claim
 * ("your auto-1h is worth $X vs the default the API crowd gets"). Honest
 * flip for the (unusual) positive-delta subscriber.
 */
function receiptHeadline(s: Summary, sym: Sym): string {
  const delta = s.counterfactual.delta1hMinus5m;
  if (delta < 0) {
    return `Your 1h cache saved you ~${fmtDollars(Math.abs(delta))} ${s.currency} vs a 5m world ${windowLabel(s)}.`;
  }
  return `A 5m world would have cost ~${fmtDollars(delta)} ${s.currency} less ${windowLabel(s)} ${sym.dash} unusual for a subscription pattern.`;
}

function endingReceipt(s: Summary, ink: Ink, sym: Sym): EndingRender {
  const pctReceived1h = s.ttlRealityCheck.received === "1h";
  // Line 3 of the receipt: the TTL verification. Percentage is the 1h WRITE
  // SHARE for the analyzed window (oneHourWriteShare), not R/C.
  const verifyLine = pctReceived1h
    ? `1h already yours, verified in your transcripts: ${fmtPct(oneHourWriteShare(s))} of writes are 1h ${sym.check}`
    : `TTL received (last ${s.ttlRealityCheck.windowDays}d): ${s.ttlRealityCheck.received} ${sym.dash} subscriptions get 1h automatically; if you're seeing 5m, an overage likely dropped you to API rates.`;
  const lines: string[] = [
    ink.bold("YOUR RECEIPT"),
    "",
    // Ordering is load-bearing (snapshot-tested):
    // 1) the 1h-vs-5m counterfactual headline, 2) vs-uncached, 3) verification.
    ...wrapTerm(receiptHeadline(s, sym)).map((l) => ink.bold(l)),
    ...wrapTerm(cachingSavedLine(s, sym)),
    ...wrapTerm(verifyLine),
    "",
    ink.bold("QUOTA-LEAK LIST") + ink.dim(` ($-equivalent, API list rates ${sym.dash} not a bill)`),
  ];
  const quotaRows = leakRowsForDisplay(s.leaks);
  for (const l of quotaRows) {
    const label = shortLeakLabel(l.label);
    lines.push(`  ${l.informational ? ink.dim(sym.dot) : ink.yellow(sym.bullet)} ${label}: ${fmtDollars(l.dollars)}-eq (${fmtPct(l.shareOfWriteSpend)} of spend)`);
  }
  lines.push("");
  lines.push(...wrapTerm("note: subagents still run on 5m even under 1h; overage drops you to 5m and bills API rates.").map((l) => ink.dim(l)));
  lines.push(ink.dim(watchTeaser(sym)));
  return { lines, needsConsent: false };
}

function leakRowsForDisplay(leaks: LeakRow[]): LeakRow[] {
  // Fixed order per the Summary schema (already the array order); render
  // zeros gracefully — an honest $0 row (no sidechain usage on this machine,
  // etc.) is still shown.
  return leaks;
}

// -------------------------------------------------------------- share rail

export function shareRail(ink: Ink, sym: Sym): string[] {
  return [ink.dim(METHODOLOGY_HINT), ink.dim(shareHint(sym))];
}

// -------------------------------------------------------------- full render

export interface FullRenderResult {
  lines: string[];
  ending: EndingKind;
  needsConsent: boolean;
  consentVerb?: "enable" | "revert";
}

/**
 * Assemble the checkup sections (score box onward) as static text (the trust
 * line's live counter is CLI-driven and not included here — cli.ts prints it
 * before calling this, then this function's output follows). This is the
 * shape used by the plain (no-TTY) checkup AND is what the TTY path prints
 * after its own staggered reveal of the trust line and CHECKUP header
 * (cli.ts re-uses checkupLines()/numberBox() etc. directly for the staggered
 * path; renderFull is the single-shot non-TTY / --compact base).
 */
export function renderFull(s: Summary, opts: RenderOptions): FullRenderResult {
  const ink = makeInk(opts.tty && !opts.noColor);
  const useAscii = !opts.tty;
  const sym = makeSym(!opts.tty);
  const kind = decideEnding(s);
  const ending = renderEnding(s, kind, ink, sym);

  const lines: string[] = [];
  lines.push(trustLine(ink, sym));
  lines.push("");
  lines.push(...checkupLines(s, ink, sym));
  lines.push("");
  lines.push(numberBox(s, ink, sym));
  lines.push("");
  lines.push(...gapBars(s, ink, useAscii, sym));
  lines.push("");
  lines.push(...wrappedLines(s, ink, sym));
  lines.push("");
  lines.push(...ending.lines);
  lines.push("");
  lines.push(...shareRail(ink, sym));

  return { lines, ending: kind, needsConsent: ending.needsConsent, consentVerb: ending.consentVerb };
}

// -------------------------------------------------------------------- card

/** `card`: score box + top Wrapped line + brandmark, fixed width, the canonical screenshot. */
export function renderCard(s: Summary, opts: RenderOptions): string {
  const ink = makeInk(opts.tty && !opts.noColor);
  const sym = makeSym(!opts.tty);
  const top = wrappedLines(s, ink, sym).slice(1, 2); // first insight line only (already prefixed with "  » ")
  const lines = [numberBox(s, ink, sym), "", ...top, "", shareRail(ink, sym)[1]];
  return lines.join("\n");
}

// --------------------------------------------------------------- compact

/** `--compact`: ~15 lines. Score, verdict, biggest miss, worst day, top 2 wrapped, share hint. */
export function renderCompact(s: Summary, opts: RenderOptions): string {
  const ink = makeInk(opts.tty && !opts.noColor);
  const sym = makeSym(!opts.tty);
  const kind = decideEnding(s);
  const lines: string[] = [];
  lines.push(`${BRAND} ${sym.dash} score ${s.efficiencyScore.toFixed(1)}/100 (${scoreLabel(s.efficiencyScore, sym, kind)})`);
  lines.push(verdictLine(s, ink, sym));
  if (s.biggestMiss) {
    lines.push(
      `biggest miss: ${fmtTokensCompact(s.biggestMiss.tokens)}-token re-warm ${sym.dash} ${fmtDollarsEq(s, s.biggestMiss.dollars)} in one turn`,
    );
  }
  if (s.worstDay) {
    lines.push(`worst day: ${s.worstDay.day} ${sym.dash} ${fmtDollarsEq(s, s.worstDay.dollars)} leaked`);
  }
  const wl = wrappedLines(s, ink, sym).slice(1, 3);
  lines.push(...wl);
  lines.push(shareRail(ink, sym)[1]);
  return lines.join("\n");
}

// -------------------------------------------------------------------- md

/** `--md`: plain markdown, zero ANSI, the corporate Slack/Teams payload. */
export function renderMarkdown(s: Summary): string {
  const kind = decideEnding(s);
  const cf = s.counterfactual;
  const lines: string[] = [];
  lines.push(`### ${BRAND} checkup`);
  lines.push("");
  // --md is prose-exempt from the ASCII sweep (see the craft-laws comment
  // above); scoreLabel takes a Sym, so pass the Unicode table explicitly to
  // keep this function's own output byte-identical across refactors.
  lines.push(`**Score:** ${s.efficiencyScore.toFixed(1)} / 100 — ${scoreLabel(s.efficiencyScore, makeSym(false), kind)}`);
  lines.push("");
  lines.push(`- Window: ${s.window.mode === "all-time" ? "all-time" : `last ${s.window.days} days`} (${s.scope.sessions.toLocaleString()} sessions, ${s.scope.turns.toLocaleString()} turns)`);
  lines.push(`- TTL received (last ${s.ttlRealityCheck.windowDays}d): ${s.ttlRealityCheck.received}`);
  lines.push(`- Recoverable ratio: ${fmtPct(s.recoverableRatio)} (break-even ${fmtPct(s.threshold)})`);
  lines.push("");
  lines.push(`| Leak | Tokens | ${s.currency === "USD" ? "$" : "$-eq"} | % of write spend |`);
  lines.push(`|---|---:|---:|---:|`);
  for (const l of s.leaks) {
    lines.push(`| ${l.label}${l.informational ? " _(info)_" : ""} | ${fmtTokens(l.tokens)} | ${fmtDollars(l.dollars)} | ${fmtPct(l.shareOfWriteSpend)} |`);
  }
  lines.push("");
  if (s.biggestMiss) {
    // Same currency discipline as the table header two lines up ($ vs $-eq).
    lines.push(`**Biggest single miss:** ${fmtTokensCompact(s.biggestMiss.tokens)}-token re-warm — ${fmtDollarsEq(s, s.biggestMiss.dollars)} in one turn.`);
  }
  if (s.worstDay) {
    lines.push(`**Worst day:** ${s.worstDay.day} — ${fmtDollarsEq(s, s.worstDay.dollars)} leaked.`);
  }
  lines.push("");
  if (kind === "A-enable") {
    lines.push(`**Verdict:** switching to the 1h TTL saves ~${fmtDollars(Math.abs(cf.delta30d))}/30d. Run \`npx @m8t-labs/cache-cash enable\` to apply.`);
  } else if (kind === "A-revert") {
    lines.push(`**Verdict:** 5m would cost ~${fmtDollars(Math.abs(cf.delta30d))}/30d less for this pattern. Run \`npx @m8t-labs/cache-cash revert\` to apply.`);
  } else if (kind === "B") {
    lines.push(`**Verdict:** certified optimal ✓ — you're on the cheaper TTL for your pattern.`);
  } else {
    // Mirrors the receipt's ordering: the 1h-vs-5m counterfactual leads the
    // verdict; vs-uncached follows on its own line.
    const uni = makeSym(false);
    lines.push(
      `**Verdict:** 1h already yours (subscription) ✓ — ${receiptHeadline(s, uni).replace(/^Your/, "your").replace(/^A /, "a ")}`,
    );
    lines.push(cachingSavedLine(s, uni));
  }
  lines.push("");
  lines.push(`_${METHODOLOGY_HINT}_`);
  return lines.join("\n");
}

// --------------------------------------------------------------- explain

/** `--explain`: every formula with the user's own numbers substituted. */
export function renderExplain(s: Summary): string {
  const b = s.buckets;
  const cf = s.counterfactual;
  const lines: string[] = [];
  lines.push(`${BRAND} --explain — every formula, your numbers substituted`);
  lines.push("=".repeat(60));
  lines.push("");
  lines.push("Gap classes (per turn vs previous turn, same session):");
  lines.push(`  warm <=5m | recoverable 5-60m | cold >60m`);
  lines.push("");
  lines.push("Your buckets (creation tokens):");
  lines.push(`  warm = ${fmtTokens(b.warm)}`);
  lines.push(`  recoverable (R) = ${fmtTokens(b.recoverable)}`);
  lines.push(`  cold = ${fmtTokens(b.cold)}`);
  lines.push(`  total (C) = ${fmtTokens(b.creationTotal)}`);
  lines.push("");
  lines.push(`R/C = ${fmtTokens(b.recoverable)} / ${fmtTokens(b.creationTotal)} = ${s.recoverableRatio.toFixed(4)} (${fmtPct(s.recoverableRatio)})`);
  lines.push("");
  lines.push("Break-even (pure-5m case): 1h cheaper iff R/C > (2-1.25)/(2-0.1) = 0.75/1.9");
  lines.push(`  = ${s.threshold.toFixed(4)} (${fmtPct(s.threshold)})`);
  lines.push(`  your R/C ${s.recoverableRatio > s.threshold ? ">" : "<="} threshold => ${s.aboveThreshold ? "1h wins on a pure-5m pattern" : "5m still optimal on a pure-5m pattern"}`);
  lines.push("");
  lines.push("Actual cost reconstruction: sum over turns of c5*1.25P + c1*2P + read*0.1P");
  lines.push(`  = ${fmtDollars(cf.actualCost)} (${s.currency})`);
  lines.push("");
  lines.push("Counterfactual 5m-world (all creation at 1.25P; recoverable-gap reads re-warm at 1.25P):");
  lines.push(`  = ${fmtDollars(cf.cost5m)}`);
  lines.push("");
  lines.push("Counterfactual 1h-world (recoverable creation -> read@0.1P + bounded tail write@2P; else creation@2P):");
  lines.push(`  = ${fmtDollars(cf.cost1h)}  (tail estimate: ${fmtTokens(cf.tailWriteTokens)} tokens, ${fmtDollars(cf.tailWriteCost)})`);
  lines.push("");
  lines.push(`delta = cost1h - cost5m = ${fmtDollars(cf.cost1h)} - ${fmtDollars(cf.cost5m)} = ${fmtDollars(cf.delta1hMinus5m)}`);
  lines.push(`  (negative => 1h cheaper). Normalized to 30d: ${fmtDollars(cf.delta30d)} (span analyzed: ${cf.spanDays.toFixed(1)}d)`);
  lines.push("");
  lines.push("Efficiency score = 100 * captured / (captured + avoidable)");
  const avoidable = s.leaks
    .filter((l) => l.cause === "ttl-expiry-rewarm" || l.cause === "model-switch")
    .reduce((sum, l) => sum + l.dollars, 0);
  const denom = s.efficiencyScore > 0 ? avoidable / (100 / s.efficiencyScore - 1) : 0;
  lines.push(`  avoidable (ttl-expiry-rewarm + model-switch $) = ${fmtDollars(avoidable)}`);
  lines.push(`  captured (implied from score) ~= ${fmtDollars(denom)}`);
  lines.push(`  score = ${s.efficiencyScore.toFixed(1)} / 100`);
  lines.push("");
  lines.push("Full derivation + worked example: METHODOLOGY.md");
  return lines.join("\n");
}

// -------------------------------------------------------------- ambiguous

/** Non-interactive (--json or piped) ambiguous-branch notice. Small, honest, no prose guess. */
export function renderAmbiguousNotice(): string {
  return [
    `${BRAND}: couldn't determine your billing branch from transcripts or settings.`,
    "Run interactively (not piped, not --json) to answer one question, or pass",
    "a hint via env (ANTHROPIC_API_KEY / CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX).",
  ].join("\n");
}

export { wrapLine };
