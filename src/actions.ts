/**
 * Actions API — the ONLY write path in cache-cash.
 *
 * "100% local, read-only except one confirmed line" is enforced entirely by
 * this module. Treat every function here like a migration script:
 * read -> validate -> backup -> targeted edit -> report. Never a blind
 * overwrite.
 *
 * Public API:
 *
 *   applyEnable(opts: ActionOpts): ActionResult
 *   applyRevert(opts: ActionOpts): ActionResult
 *   runVerify(opts: ActionOpts): Promise<ActionResult>
 *   runRecheck(opts: ActionOpts): Promise<ActionResult>
 *
 * `home` is REQUIRED (not defaulted to os.homedir() in here) on purpose: the
 * highest-blast-radius code in the repo should make it structurally
 * impossible to accidentally touch a real home from a code path that forgot
 * to think about it. Callers (cli.ts, tests) must always be explicit.
 *
 * `--json` mode never reaches these functions at all — cli.ts's dispatch()
 * returns before the subcommand switch whenever args.json is true (see
 * cli.ts's "`--json` always wins" comment), so the never-writes law for
 * `--json` is enforced structurally at the call site, not by a flag in here.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { run } from "./pipeline.js";
import type { Summary } from "./types.js";

// -------------------------------------------------------------------- types

export interface ActionOpts {
  /** Required. Never defaulted internally — every call site must be explicit. */
  home: string;
  /** Defaults to process.env. Test hook for the FORCE_PROMPT_CACHING_5M-via-env refuse path. */
  env?: NodeJS.ProcessEnv;
  /**
   * The current run's Summary, if available (cli.ts has it in scope at the
   * consent call site — the plumbing to pass it through is already there).
   * Used only to write the baseline file on successful enable. Optional:
   * enable still applies the flag without it, it just skips the baseline
   * write (recheck will then correctly report "no baseline found").
   */
  summary?: Summary;
  /**
   * applyRevert only: also set FORCE_PROMPT_CACHING_5M=1 instead of just
   * removing ENABLE_PROMPT_CACHING_1H. This honors an explicit --force-5m
   * variant only when trivially clean — applied only when there is no OTHER
   * conflicting env write already in flight (there never is, since force +
   * the enable-flag-removal are the only two things this call touches).
   */
  force?: boolean;
}

export interface ActionResult {
  /** true if a real write happened. */
  applied: boolean;
  /** Lines to print to the user. */
  message: string[];
  /**
   * runRecheck only (v1.0.1, additive): the computed "since switching" $
   * delta (positive = 1h saved money vs a 5m world). Exposed so cli.ts can
   * re-offer the share prompt after a receipt that shows positive savings —
   * one of the two high-emotion re-ask moments. Never set by other actions.
   */
  savedSinceEnable?: number;
}

const SETTINGS_REL = [".claude", "settings.json"];
const BACKUP_REL = [".claude", "settings.json.cache-cash.bak"];
const BASELINE_REL = [".claude", "cache-cash.json"];

const ENABLE_KEY = "ENABLE_PROMPT_CACHING_1H";
const FORCE_5M_KEY = "FORCE_PROMPT_CACHING_5M";

const ISSUE_49139 =
  "known flakiness: server-side TTL flips have happened before " +
  "(anthropics/claude-code#49139) — verify is how you catch it, not paranoia.";

// ------------------------------------------------------------ settings I/O

interface SettingsDoc {
  [key: string]: unknown;
}

interface ReadResult {
  /** null when the file didn't exist at all (a valid, non-error state). */
  doc: SettingsDoc | null;
  existed: boolean;
  /** Set when the file existed but failed to parse as a JSON object. */
  parseError: string | null;
}

function settingsPath(home: string): string {
  return join(home, ...SETTINGS_REL);
}
function backupPath(home: string): string {
  return join(home, ...BACKUP_REL);
}
function baselinePath(home: string): string {
  return join(home, ...BASELINE_REL);
}

/**
 * Read + parse settings.json. Never throws: malformed JSON or a non-object
 * top level comes back as `parseError` so callers can abort with a clear
 * message instead of crashing or, worse, silently proceeding with garbage.
 */
function readSettings(home: string): ReadResult {
  const p = settingsPath(home);
  if (!existsSync(p)) {
    return { doc: null, existed: false, parseError: null };
  }
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    return {
      doc: null,
      existed: true,
      parseError: `could not read ${p}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      doc: null,
      existed: true,
      parseError: `${p} contains malformed JSON and was NOT modified: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      doc: null,
      existed: true,
      parseError: `${p} does not contain a JSON object at the top level and was NOT modified.`,
    };
  }
  const doc = parsed as SettingsDoc;
  // The "env" key, if present, must be either absent/null (treated as "no
  // env block yet" — a benign, common way to represent empty) or a genuine
  // JSON object. A STRING/ARRAY/NUMBER "env" is the one shape a silent
  // coerce-and-overwrite would violate the "preserve ALL other keys" promise
  // for — we'd otherwise replace the user's original (broken) env value with
  // a brand-new object containing only the flag we're setting, discarding
  // whatever was there without saying so. Treat that the same as any other
  // malformed-settings case: refuse and report, never silently discard.
  // `null` specifically is NOT treated as malformed (unlike top-level null,
  // checked above) because "env": null is a plausible, harmless way for a
  // hand-edit or another tool to represent "no env vars set."
  const envVal = doc["env"];
  if (envVal !== undefined && envVal !== null && (typeof envVal !== "object" || Array.isArray(envVal))) {
    return {
      doc: null,
      existed: true,
      parseError:
        `${p}'s "env" key is present but is not a JSON object ` +
        `(got ${Array.isArray(envVal) ? "an array" : JSON.stringify(envVal)}). ` +
        `cache-cash refuses to guess what to do with a malformed "env" block — ` +
        `fix it by hand (it should be an object like {"SOME_KEY": "value"}) and ` +
        `try again. File was NOT modified.`,
    };
  }
  return { doc, existed: true, parseError: null };
}

/** Write a backup copy of the CURRENT on-disk settings.json (only called when it existed). */
/**
 * Deliberately NOT atomic (plain writeFileSync, not atomicWriteFileSync).
 * This write happens BEFORE the real settings.json edit — if it throws
 * (disk full, EACCES), the exception propagates up and the primary
 * settings.json write below never runs (fail-closed: see the
 * "if the backup write fails..." test in actions.test.ts). If it succeeds
 * but is somehow torn by a mid-write crash, the worst case is a corrupted
 * BACKUP file while the original settings.json is still fully intact
 * (we haven't touched it yet at this point) — recoverable, not data loss.
 * Atomicity matters most for the file being actively overwritten in place
 * (settings.json itself, via atomicWriteFileSync); it's lower-value here.
 */
function writeBackup(home: string, currentRaw: string): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(backupPath(home), currentRaw, "utf8");
}

/**
 * Serialize with 2-space indentation (matches Claude Code's own settings.json
 * formatting — confirmed against a real settings.json) plus a trailing
 * newline. This is a full reserialize of the parsed object, which
 * means: whitespace *within* unrelated values is not "preserved" in the
 * literal-bytes sense (JSON has no comments/whitespace-in-values to lose),
 * but every KEY and every VALUE the file had is preserved exactly, and the
 * overall indent style matches what a user (or Claude Code itself) would
 * have produced. This is the "preserve unknown keys + 2-space formatting"
 * contract; it is not a byte-diff-preserving patch (deliberately — JSON has
 * no stable notion of "preserve original byte layout" without also carrying
 * comments/trailing-comma quirks that plain JSON.parse/stringify can't and
 * shouldn't round-trip).
 */
function serialize(doc: SettingsDoc): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * Write `contents` to `path` atomically: write to a same-directory sibling
 * temp file, then rename over the destination. `writeFileSync` directly to
 * the final path is NOT crash-atomic — a kill/power-loss mid-write can leave
 * a truncated, unparseable settings.json. `rename()` on the same filesystem
 * is atomic on POSIX (and on Windows via Node's fs.renameSync, which uses
 * MoveFileEx with the replace flag), so a crash either leaves the OLD file
 * fully intact or the NEW one fully intact — never a half-written mix. This
 * is on top of, not instead of, the backup-first discipline: the backup
 * protects against a bad EDIT (revert if the new content was wrong); this
 * protects against a bad WRITE (crash mid-syscall).
 */
function atomicWriteFileSync(path: string, contents: string): void {
  const tmp = `${path}.cache-cash.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, path);
}

function truthyEnvValue(v: unknown): boolean {
  return v === "1" || v === 1 || v === true || v === "true";
}

/** FORCE_PROMPT_CACHING_5M check: settings.json env OR process env, either one refuses. */
function force5mIsSet(doc: SettingsDoc | null, env: NodeJS.ProcessEnv): boolean {
  if (doc) {
    const envBlock = doc["env"];
    if (envBlock && typeof envBlock === "object" && !Array.isArray(envBlock)) {
      if (truthyEnvValue((envBlock as Record<string, unknown>)[FORCE_5M_KEY])) return true;
    }
  }
  return env[FORCE_5M_KEY] === "1";
}

/** Compute a small diff summary of changed env keys for the "show the exact diff" requirement. */
function envDiffLines(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const b = before[k];
    const a = after[k];
    if (b === a) continue;
    if (b === undefined) lines.push(`  + "${k}": ${JSON.stringify(a)}`);
    else if (a === undefined) lines.push(`  - "${k}": ${JSON.stringify(b)}`);
    else lines.push(`  ~ "${k}": ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
  }
  return lines;
}

// ---------------------------------------------------------------- baseline

interface BaselineFile {
  /** ISO-8601 timestamp of the enable call that wrote this baseline. */
  enabled_at: string;
  /** The --days window in effect for the summary that produced this baseline. */
  window_days: number | null;
  branch: string;
  currency: string;
  recoverableRatio: number;
  efficiencyScore: number;
  delta30d: number;
  /** Actual reconstructed spend over the enabling summary's window, for receipts math. */
  actualCostAtEnable: number;
  /**
   * v1.0.1 share-CTA frequency guard: set when the checkup's share prompt
   * has been shown once on this machine (aggregate metadata only — a
   * timestamp, never content). Lives in this file because the baseline is
   * the one local state file cache-cash owns; readBaseline() still requires
   * `enabled_at`, so a share-only file (recorded before any enable) is
   * correctly NOT a recheck baseline.
   */
  sharePrompt?: { shownAt: string };
}

/**
 * Also deliberately NOT atomic, same reasoning as writeBackup: this is a
 * purely additive convenience file (recheck receipts), never settings.json
 * itself, and readBaseline() already treats a malformed/torn baseline file
 * as "no baseline" (a safe degraded state — runRecheck tells the user to
 * re-run enable — not silent corruption of anything load-bearing).
 */
function writeBaseline(home: string, summary: Summary): void {
  // Preserve any pre-existing share-prompt marker (and be tolerant of a
  // share-only file written before the first enable) — a fresh enable must
  // never re-arm the once-per-machine share prompt.
  const existing = readBaselineRaw(home);
  const baseline: BaselineFile = {
    enabled_at: new Date().toISOString(),
    window_days: summary.window.days,
    branch: summary.branch,
    currency: summary.currency,
    recoverableRatio: summary.recoverableRatio,
    efficiencyScore: summary.efficiencyScore,
    delta30d: summary.counterfactual.delta30d,
    actualCostAtEnable: summary.counterfactual.actualCost,
    ...(existing?.sharePrompt ? { sharePrompt: existing.sharePrompt } : {}),
  };
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(baselinePath(home), JSON.stringify(baseline, null, 2) + "\n", "utf8");
}

/** Raw baseline read: tolerates partial shapes (e.g. a share-only file). */
function readBaselineRaw(home: string): Partial<BaselineFile> | null {
  const p = baselinePath(home);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Partial<BaselineFile>;
  } catch {
    return null;
  }
}

function readBaseline(home: string): BaselineFile | null {
  const parsed = readBaselineRaw(home);
  if (!parsed || typeof parsed.enabled_at !== "string") return null;
  return parsed as BaselineFile;
}

// ------------------------------------------------------- share-prompt guard

/**
 * v1.0.1 share-CTA frequency guard (cli.ts consumes these two). The checkup
 * asks ONCE per machine ever; cli.ts bypasses the check (but still records)
 * at the two high-emotion re-ask moments (post-enable, positive recheck).
 * Aggregate-numbers-only discipline: the marker is a timestamp, nothing else.
 */
export function sharePromptShown(home: string): boolean {
  return typeof readBaselineRaw(home)?.sharePrompt?.shownAt === "string";
}

export function recordSharePromptShown(home: string): void {
  const existing = readBaselineRaw(home) ?? {};
  const next = { ...existing, sharePrompt: { shownAt: new Date().toISOString() } };
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(baselinePath(home), JSON.stringify(next, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------- enable

export function applyEnable(opts: ActionOpts): ActionResult {
  const env = opts.env ?? process.env;
  const { doc: existingDoc, existed, parseError } = readSettings(opts.home);

  if (parseError) {
    return {
      applied: false,
      message: [
        "cache-cash: refusing to edit settings.json.",
        parseError,
        "Fix the JSON by hand (or restore from a backup) and try again — cache-cash",
        "will never overwrite a file it can't safely parse.",
      ],
    };
  }

  if (force5mIsSet(existingDoc, env)) {
    return {
      applied: false,
      message: [
        `cache-cash: refusing to enable — ${FORCE_5M_KEY} is set.`,
        "That flag explicitly pins you to the 5m cache TTL (it exists to force 5m",
        "even on plans that would otherwise get 1h). Enabling 1h on top of it would",
        "be a silent no-op at best and a confusing conflict at worst.",
        `Remove ${FORCE_5M_KEY} first (cache-cash revert can help) if you actually`,
        "want 1h.",
      ],
    };
  }

  const before: SettingsDoc = existingDoc ?? { env: {} };
  const beforeEnv = (before["env"] && typeof before["env"] === "object" && !Array.isArray(before["env"])
    ? (before["env"] as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const afterEnv = { ...beforeEnv, [ENABLE_KEY]: "1" };
  const after: SettingsDoc = { ...before, env: afterEnv };

  // Backup first — only meaningful (and only created) when a real file existed.
  if (existed) {
    const currentRaw = readFileSync(settingsPath(opts.home), "utf8");
    writeBackup(opts.home, currentRaw);
  }

  mkdirSync(join(opts.home, ".claude"), { recursive: true });
  atomicWriteFileSync(settingsPath(opts.home), serialize(after));

  if (opts.summary) {
    writeBaseline(opts.home, opts.summary);
  }

  const diff = envDiffLines(beforeEnv, afterEnv);

  const message: string[] = [
    existed
      ? `cache-cash: updated ${settingsPath(opts.home)} (backup: ${backupPath(opts.home)}).`
      : `cache-cash: created ${settingsPath(opts.home)} (no previous file existed).`,
    "",
    "Diff applied to the env block:",
    ...diff,
    "",
    "This takes effect on your NEXT session — the flag only applies to sessions",
    "started after this change, not the one you're in right now.",
    "",
    "Fully reversible: run `cache-cash revert` any time to undo this.",
    "",
    "To confirm it actually landed: after a few turns in a fresh session, run",
    "`cache-cash verify` (or `npx @m8t-labs/cache-cash --days 1`) — the TTL reality check",
    "reflects what your transcripts actually received, not what settings.json says.",
    "",
    ISSUE_49139,
  ];

  if (opts.summary) {
    message.push("", `Baseline saved to ${baselinePath(opts.home)} — \`cache-cash recheck\` will use it later.`);
  }

  return { applied: true, message };
}

// ---------------------------------------------------------------- revert

export function applyRevert(opts: ActionOpts): ActionResult {
  const { doc: existingDoc, existed, parseError } = readSettings(opts.home);

  if (parseError) {
    return {
      applied: false,
      message: [
        "cache-cash: refusing to edit settings.json.",
        parseError,
        "Fix the JSON by hand (or restore from a backup) and try again.",
      ],
    };
  }

  if (!existed || !existingDoc) {
    return {
      applied: false,
      message: [
        "cache-cash: nothing to revert — settings.json doesn't exist, so the",
        "1h flag was never set by cache-cash (or anything else) in the first place.",
      ],
    };
  }

  const beforeEnv = (existingDoc["env"] && typeof existingDoc["env"] === "object" && !Array.isArray(existingDoc["env"])
    ? (existingDoc["env"] as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const afterEnv: Record<string, unknown> = { ...beforeEnv };
  delete afterEnv[ENABLE_KEY];
  if (opts.force) {
    afterEnv[FORCE_5M_KEY] = "1";
  }

  const after: SettingsDoc = { ...existingDoc, env: afterEnv };

  const currentRaw = readFileSync(settingsPath(opts.home), "utf8");
  writeBackup(opts.home, currentRaw);

  atomicWriteFileSync(settingsPath(opts.home), serialize(after));

  const diff = envDiffLines(beforeEnv, afterEnv);

  const message: string[] = [
    `cache-cash: updated ${settingsPath(opts.home)} (backup: ${backupPath(opts.home)}).`,
    "",
    "Diff applied to the env block:",
    ...diff.length > 0 ? diff : ["  (no ENABLE_PROMPT_CACHING_1H was set — nothing to remove)"],
    "",
    "This takes effect on your NEXT session.",
    "",
    "Fully reversible: run `cache-cash enable` any time to switch back to 1h.",
  ];

  if (opts.force) {
    message.push(
      "",
      `${FORCE_5M_KEY}=1 was also set — this explicitly pins you to 5m even on plans`,
      "that would otherwise default to 1h. Remove it from settings.json by hand if",
      "you just wanted the plain revert.",
    );
  }

  return { applied: true, message };
}

// ---------------------------------------------------------------- verify

/**
 * `cache-cash verify` — re-runs the pipeline (no new transcript-reading
 * code: it re-runs run({days:1,...}) from pipeline.ts and reads
 * summary.ttlRealityCheck) over a small recent window.
 *
 * Window choice: since baseline/enable if one exists (days = ceil(now -
 * enabled_at)), else the last 24h (days: 1) as the fallback rule.
 */
export async function runVerify(opts: ActionOpts): Promise<ActionResult> {
  const baseline = readBaseline(opts.home);
  const days = baseline ? daysSince(baseline.enabled_at) : 1;

  const result = await run({ home: opts.home, days, allTime: false, jsonMode: true });

  if (!result.summary || result.code === 1) {
    return {
      applied: false,
      message: [
        "cache-cash verify: no fresh sessions yet — do a few turns in a new session",
        "first, then run this again. (Looked for transcripts " +
          (baseline ? `since ${baseline.enabled_at}` : "in the last 24h") +
          ".)",
      ],
    };
  }

  const reality = result.summary.ttlRealityCheck;

  if (reality.regime === "none") {
    return {
      applied: false,
      message: [
        "cache-cash verify: no fresh sessions yet — no cache writes found in the",
        "window checked. Do a few turns in a new session, then run this again.",
      ],
    };
  }

  if (reality.regime === "1h") {
    return {
      applied: false,
      message: [
        `cache-cash verify: working end to end ✓`,
        `Your transcripts show 1h cache writes landing (${fmtInt(reality.creation1h)} tokens` +
          ` at 1h vs ${fmtInt(reality.creation5m)} at 5m, last ${reality.windowDays}d).`,
        "The 1h TTL is actually in effect, not just set in settings.json.",
      ],
    };
  }

  // regime === "5m" — the flag may be set but the server isn't honoring it.
  return {
    applied: false,
    message: [
      "cache-cash verify: still 5m — likely gateway/downgrade.",
      `Your transcripts show 5m cache writes (${fmtInt(reality.creation5m)} tokens) and` +
        ` no 1h writes in the last ${reality.windowDays}d, even though the point of` +
        " enabling was to get 1h.",
      "If you just enabled and haven't started a NEW session yet, that's expected —",
      "the flag only applies to sessions started after the change.",
      "If you HAVE started a fresh session and it's still 5m, this is the " + ISSUE_49139,
    ],
  };
}

// --------------------------------------------------------------- recheck

/**
 * `cache-cash recheck` — baseline vs since-enable actuals + counterfactual.
 * "since switching: ~$X saved" receipt.
 *
 * Math (no new analyzer logic — reuses costmodel.ts's existing counterfactual
 * via a fresh run() over the since-enable window):
 *   since = run({days: daysSinceEnable, home})
 *   saved = since.counterfactual.cost5m - since.counterfactual.actualCost
 * `cost5m` is "what this same post-enable activity would have cost under a
 * pure-5m TTL" — already computed by the analyzer for any window, regime-
 * agnostic. `actualCost` is what was really spent. The difference is exactly
 * "since switching, vs the counterfactual world where you hadn't."
 */
export async function runRecheck(opts: ActionOpts): Promise<ActionResult> {
  const baseline = readBaseline(opts.home);
  if (!baseline) {
    return {
      applied: false,
      message: [
        "cache-cash recheck: no baseline found — you haven't run `cache-cash enable`",
        "on this machine yet (or the baseline file was removed).",
        "Run `cache-cash enable` first; recheck compares against the numbers saved",
        "at that moment.",
      ],
    };
  }

  const days = daysSince(baseline.enabled_at);
  const since = await run({ home: opts.home, days, allTime: false, jsonMode: true });

  if (!since.summary || since.code === 1) {
    return {
      applied: false,
      message: [
        `cache-cash recheck: no sessions found since you enabled (${baseline.enabled_at}).`,
        "Use Claude Code for a while after enabling, then check back.",
      ],
    };
  }

  const s = since.summary;
  const cf = s.counterfactual;
  const saved = cf.cost5m - cf.actualCost; // positive = 1h saved money vs a 5m world
  const scoreDelta = s.efficiencyScore - baseline.efficiencyScore;

  const verb = saved >= 0 ? "saved" : "cost you";
  const amount = fmtUsd(Math.abs(saved));
  const currency = s.currency;

  const message: string[] = [
    `cache-cash recheck: since switching (${baseline.enabled_at.slice(0, 10)}, ${days}d ago):`,
    "",
    `  ~${amount} ${currency} ${verb} vs a 5m world over that same activity.`,
    `  Efficiency score: ${baseline.efficiencyScore.toFixed(1)} -> ${s.efficiencyScore.toFixed(1)}` +
      ` (${scoreDelta >= 0 ? "+" : ""}${scoreDelta.toFixed(1)}).`,
    `  Recoverable ratio: ${(baseline.recoverableRatio * 100).toFixed(1)}% -> ` +
      `${(s.recoverableRatio * 100).toFixed(1)}%.`,
    "",
    saved >= 0
      ? "This is the receipt — the switch is paying off."
      : "This period cost more under 1h than 5m would have — worth a `cache-cash`" +
          " full checkup to see if your pattern has shifted (e.g. much lower usage" +
          " volume can flip the break-even the other way).",
  ];

  return { applied: false, message, savedSinceEnable: saved };
}

// ------------------------------------------------------------------ utils

function daysSince(isoTs: string): number {
  const then = Date.parse(isoTs);
  if (Number.isNaN(then)) return 1;
  const diffDays = (Date.now() - then) / 86_400_000;
  return Math.max(1, Math.ceil(diffDays));
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
