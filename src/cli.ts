#!/usr/bin/env node
/**
 * The full CLI surface.
 *
 *   npx @m8t-labs/cache-cash                 full checkup
 *   npx @m8t-labs/cache-cash card            score box + top Wrapped line
 *   npx @m8t-labs/cache-cash enable          confirmed 1h-TTL enable flow
 *   npx @m8t-labs/cache-cash revert          confirmed 5m-TTL revert flow
 *   npx @m8t-labs/cache-cash verify          post-enable TTL check
 *   npx @m8t-labs/cache-cash recheck         baseline comparison
 *
 *   --days N (90) · --project <path> · --price <model=$/MTok,...> · --yes ·
 *   --no-color · --all-time · --json · --md · --compact · --explain ·
 *   --projects (v1.0.1: opt back into project names in human output;
 *               default is share-safe — no project names in screenshots)
 *
 * Exit codes: 0 ok · 1 no transcripts found · 2 parse/internal error.
 * `--json` never prompts.
 *
 * TTY-ness is decided ONCE, here, up front, and threaded through every
 * render call as `opts.tty` — render.ts and format.ts never call
 * process.stdout.isTTY themselves.
 */

import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { run } from "./pipeline.js";
import { parsePriceOverride } from "./pricing.js";
import {
  applyEnable,
  applyRevert,
  recordSharePromptShown,
  runRecheck,
  runVerify,
  sharePromptShown,
} from "./actions.js";
import {
  bskyIntentUrl,
  copyToClipboard,
  openExternal,
  SHARE_PROMPT_LINE,
  xIntentUrl,
} from "./share.js";
import {
  checkupLines,
  decideEnding,
  gapBars,
  makeScanProgress,
  numberBox,
  pickLoadingPun,
  renderAmbiguousNotice,
  renderCard,
  renderCompact,
  renderEnding,
  renderExplain,
  renderFull,
  renderMarkdown,
  shareRail,
  shareTemplate,
  trustLine,
  wrappedLines,
} from "./render.js";
import { makeInk, makeSym } from "./format.js";
import type { Branch, Summary } from "./types.js";

// ------------------------------------------------------------------ argv

type Subcommand = "checkup" | "card" | "enable" | "revert" | "verify" | "recheck";

interface Args {
  subcommand: Subcommand;
  days: number | null;
  allTime: boolean;
  project?: string;
  overrides?: Record<string, number>;
  yes: boolean;
  noColor: boolean;
  json: boolean;
  md: boolean;
  compact: boolean;
  explain: boolean;
  /**
   * --projects (v1.0.1): opt back into printing project names in human
   * output for local diagnosis. Default OFF — share-safe output never leaks
   * project names into screenshots. Distinct from --project <path> (scope
   * filter). --json always keeps its project fields regardless.
   */
  projects: boolean;
}

const SUBCOMMANDS = new Set<Subcommand>(["card", "enable", "revert", "verify", "recheck"]);

function parseArgs(argv: string[]): Args {
  const args: Args = {
    subcommand: "checkup",
    days: 90,
    allTime: false,
    yes: false,
    noColor: false,
    json: false,
    md: false,
    compact: false,
    explain: false,
    projects: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (i === 0 && !a.startsWith("-") && SUBCOMMANDS.has(a as Subcommand)) {
      args.subcommand = a as Subcommand;
      continue;
    }
    switch (a) {
      case "--json":
        args.json = true;
        break;
      case "--md":
        args.md = true;
        break;
      case "--compact":
        args.compact = true;
        break;
      case "--explain":
        args.explain = true;
        break;
      case "--all-time":
        args.allTime = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--no-color":
        args.noColor = true;
        break;
      case "--days": {
        const v = Number(argv[++i]);
        args.days = Number.isFinite(v) ? v : args.days;
        break;
      }
      case "--projects":
        // NOTE: distinct from --project <path> below (exact-match switch, no
        // prefix ambiguity): --projects re-enables project names in human
        // output; --project scopes the analysis to one project dir.
        args.projects = true;
        break;
      case "--project":
        args.project = argv[++i];
        break;
      case "--price":
        args.overrides = parsePriceOverride(argv[++i] ?? "");
        break;
      default:
        // Unknown flags are ignored rather than fatal — a screenshot tool
        // shouldn't crash on a typo'd flag; --json output is still valid.
        break;
    }
  }
  return args;
}

// -------------------------------------------------------------------- tty

/**
 * TTY-ness, decided once. Non-TTY (piped, redirected), CI=1, --no-color,
 * or --json all force the plain/non-interactive path. `--json` additionally
 * never prompts.
 */
function isInteractiveTty(args: Args): boolean {
  if (args.json) return false;
  if (process.env.CI) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

function useColor(args: Args, tty: boolean): boolean {
  if (args.noColor) return false;
  if (process.env.CI) return false;
  return tty;
}

// ------------------------------------------------------------- prompt/ask

/** A single [y/N]-style prompt on stdin. Never used on transcript files — stdin only. */
function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** One free-form prompt line on stdin (share CTA). */
function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ------------------------------------------------------------- share CTA

/**
 * The share CTA (v1.0.1). TTY-interactive only — never non-TTY/CI/--json/
 * --md/card/--compact (callers gate on the checkup TTY path + the two
 * forced re-ask moments). Frequency guard: asks ONCE per machine ever
 * (recorded in the baseline file via actions.ts), except `force` re-asks at
 * the two high-emotion moments (right after a successful enable; after a
 * recheck showing positive savings). Any non-[x/b/c] answer = skip, no nag.
 *
 * Trust line holds: zero network requests from this process — [x]/[b] open
 * the user's own browser with prefilled text they read before posting; [c]
 * uses the local clipboard tool.
 */
async function maybeSharePrompt(summary: Summary, force: boolean): Promise<void> {
  const interactive = process.stdout.isTTY && !process.env.CI;
  if (!interactive) return;
  if (!force && sharePromptShown(homedir())) return;

  const answer = await promptLine(`\n${SHARE_PROMPT_LINE}`);
  // Recorded regardless of the answer: once per machine, no nag.
  recordSharePromptShown(homedir());

  if (answer === "x" || answer === "b") {
    const text = shareTemplate(summary);
    const url = answer === "x" ? xIntentUrl(text) : bskyIntentUrl(text);
    const opened = await openExternal(url);
    if (!opened) {
      process.stdout.write(`couldn't launch a browser — open this yourself:\n${url}\n`);
    }
    process.stdout.write("tip: screenshot the card above and attach it.\n");
    return;
  }
  if (answer === "c") {
    const md = renderMarkdown(summary);
    const copied = await copyToClipboard(md);
    if (copied) {
      process.stdout.write("copied — paste it into Slack/Teams.\n");
    } else {
      process.stdout.write(md + "\n\n(no clipboard tool found — copy the block above)\n");
    }
  }
}

/** The one interactive branch-ambiguity question: "subscription or API/Bedrock/Vertex?". */
function promptBranch(): Promise<Branch> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      "cache-cash: couldn't tell how you pay from transcripts or settings.\n" +
        "How do you pay for Claude Code — (s)ubscription or (a)PI/Bedrock/Vertex? [s/a] ",
      (answer) => {
        rl.close();
        const a = answer.trim().toLowerCase();
        resolve(a.startsWith("a") ? "api-5m" : "subscription");
      },
    );
  });
}

// ------------------------------------------------------------------ main

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const tty = isInteractiveTty(args);
  const color = useColor(args, tty);
  const ink = makeInk(color);
  // ascii-ness tracks TTY-ness only (non-TTY/CI -> ASCII), never --no-color
  // on its own — --no-color strips color but keeps Unicode box chars on a
  // real TTY, per RenderOptions.noColor's "independent of TTY" doc.
  const sym = makeSym(!tty);

  // enable/revert are first-class subcommands and must work in a HOME with
  // zero transcripts — the settings edit needs no Summary. Route them BEFORE
  // the analysis pipeline. --json is exempt: `cache-cash enable --json` is a
  // Summary dump and never writes, so it keeps the pipeline path below.
  // verify/recheck DO need transcripts (they analyze them) and keep their
  // pipeline dependency unchanged.
  if (!args.json && (args.subcommand === "enable" || args.subcommand === "revert")) {
    return await runStandaloneAction(args);
  }

  // Live in-place scan counter (TTY checkup only), fed by pipeline.ts's
  // additive onFileParsed hook (v1.0.1 — replaces the old one-shot
  // "scanning 0/1" line that stayed stuck above the CHECKUP section).
  // The counter rewrites ONLY its own line via "\r" frames and is finalized
  // (erased) the moment run() resolves — the CHECKUP section carries the
  // final counts, and nothing above the progress line is ever touched
  // (no-screen-clear law).
  let progress: ReturnType<typeof makeScanProgress> | null = null;
  if (tty && args.subcommand === "checkup") {
    process.stdout.write(trustLine(ink, sym) + "\n");
    progress = makeScanProgress(pickLoadingPun(), ink, sym);
    const first = progress.frame(0, 0);
    if (first !== null) process.stdout.write(first);
  }

  // Always resolve with jsonMode:true internally first so we get the HONEST
  // branch (including a true "ambiguous" verdict) regardless of the user's
  // requested output mode — see verdict.ts's jsonMode-gated detectBranch.
  const baseResult = await run({
    project: args.project,
    days: args.allTime ? null : args.days,
    allTime: args.allTime,
    jsonMode: true,
    overrides: args.overrides,
    onFileParsed: progress
      ? (done, total) => {
          const p = progress!.frame(done, total);
          if (p !== null) process.stdout.write(p);
        }
      : undefined,
  });
  // Finalize the progress line BEFORE anything else prints (errors, the
  // ambiguous-branch question, the checkup itself).
  if (progress) process.stdout.write(progress.finish());

  if (baseResult.code === 1) {
    process.stderr.write("No transcripts found under ~/.claude/projects\n");
    return 1;
  }
  if (!baseResult.summary) {
    process.stderr.write("Internal error: no summary produced\n");
    return 2;
  }

  let summary = baseResult.summary;

  if (summary.branch === "ambiguous") {
    if (args.json) {
      // --json never prompts — report ambiguous as-is.
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
      return 0;
    }
    if (tty) {
      const answer = await promptBranch();
      const resolved = await run({
        project: args.project,
        days: args.allTime ? null : args.days,
        allTime: args.allTime,
        jsonMode: false,
        overrides: args.overrides,
        branchOverride: answer,
      });
      if (!resolved.summary) {
        process.stderr.write("Internal error: no summary produced\n");
        return 2;
      }
      summary = resolved.summary;
    } else {
      // Non-TTY, non-json (e.g. piped to `cat`): can't ask, don't guess wrong
      // silently — print the honest ambiguous notice and stop.
      process.stdout.write(renderAmbiguousNotice() + "\n");
      return 0;
    }
  }

  return await dispatch(args, summary, { tty, color });
}

async function dispatch(
  args: Args,
  summary: Summary,
  renderOpts: { tty: boolean; color: boolean },
): Promise<number> {
  const opts = { tty: renderOpts.tty, noColor: !renderOpts.color, showProjects: args.projects };

  // --json always wins (stable machine-readable schema).
  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }

  switch (args.subcommand) {
    case "card":
      process.stdout.write(renderCard(summary, opts) + "\n");
      return 0;

    // "enable" / "revert" never reach this switch: non-json runs are
    // early-routed to runStandaloneAction() in main() BEFORE the pipeline
    // (they must work without transcripts), and --json runs return via the
    // JSON dump above. Keeping a single standalone write path (with its
    // consent gate) avoids a second, unguarded route to applyEnable.

    case "verify": {
      const res = await runVerify({ home: homedir() });
      process.stdout.write(res.message.join("\n") + "\n");
      return 0;
    }

    case "recheck": {
      const res = await runRecheck({ home: homedir() });
      process.stdout.write(res.message.join("\n") + "\n");
      if ((res.savedSinceEnable ?? 0) > 0) {
        // High-emotion re-ask moment #2: a receipt showing positive savings.
        await maybeSharePrompt(summary, true);
      }
      return 0;
    }

    case "checkup":
    default:
      return await renderCheckup(args, summary, opts);
  }
}

/** The default multi-section checkup: --md / --compact / --explain / full (TTY staggered or plain). */
async function renderCheckup(
  args: Args,
  summary: Summary,
  opts: { tty: boolean; noColor: boolean },
): Promise<number> {
  if (args.md) {
    process.stdout.write(renderMarkdown(summary) + "\n");
    return 0;
  }
  if (args.compact) {
    process.stdout.write(renderCompact(summary, opts) + "\n");
    return 0;
  }
  if (args.explain) {
    process.stdout.write(renderExplain(summary) + "\n");
    return 0;
  }

  if (!opts.tty) {
    // Plain ASCII, no stagger, no in-place updates, single shot.
    const full = renderFull(summary, opts);
    process.stdout.write(full.lines.join("\n") + "\n");
    return await maybeConsentFromEnding(args, summary, full.needsConsent, full.consentVerb);
  }

  // TTY path: staggered reveal of the trust line and CHECKUP header, then
  // the rest prints normally. Never clears the screen at any point.
  const ink = makeInk(!opts.noColor);
  // Reached only when opts.tty is true (see the !opts.tty branch above), so
  // this is always the Unicode table — ascii-ness tracks TTY-ness.
  const sym = makeSym(false);
  await staggerPrint(checkupLines(summary, ink, sym));
  process.stdout.write("\n" + numberBox(summary, ink, sym) + "\n\n");
  process.stdout.write(gapBars(summary, ink, false, sym).join("\n") + "\n\n");
  process.stdout.write(wrappedLines(summary, ink, sym, args.projects).join("\n") + "\n\n");

  const kind = decideEnding(summary);
  const ending = renderEnding(summary, kind, ink, sym);
  process.stdout.write(ending.lines.join("\n") + "\n\n");
  process.stdout.write(shareRail(ink, sym).join("\n") + "\n");

  const code = await maybeConsentFromEnding(args, summary, ending.needsConsent, ending.consentVerb);
  // Share CTA, after the rail and after any consent flow (TTY path only —
  // the non-TTY branch above never prompts). Once per machine; the
  // post-enable re-ask inside maybeConsentFromEnding records first, which
  // makes this call a no-op in that flow.
  await maybeSharePrompt(summary, false);
  return code;
}

/** ~150ms stagger between CHECKUP's ✓✓⚠ lines, TTY only. */
async function staggerPrint(lines: string[]): Promise<void> {
  for (const line of lines) {
    process.stdout.write(line + "\n");
    await sleep(150);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Standalone `cache-cash enable` / `cache-cash revert` (first-class
 * subcommands). Runs BEFORE the analysis pipeline — the settings edit needs
 * no Summary, so a HOME with zero transcripts can still enable/revert;
 * enable/revert must work without any transcripts present, unlike the
 * "No transcripts found" gate that guards the rest of main().
 *
 * Consent discipline mirrors maybeConsentFromEnding exactly: interactive
 * [y/N] by default, --yes skips it, and a non-interactive run without --yes
 * writes NOTHING — the one write is always confirmed.
 *
 * For `enable`, the pipeline still runs best-effort AFTER consent so the
 * recheck baseline gets written when transcripts exist ("enable writes a
 * small local baseline file"). Analysis failure or an empty corpus skips the
 * baseline silently — it is convenience data for recheck receipts, never a
 * precondition for the settings edit.
 */
async function runStandaloneAction(args: Args): Promise<number> {
  const verb: "enable" | "revert" = args.subcommand === "enable" ? "enable" : "revert";
  const interactive = process.stdout.isTTY && !process.env.CI;
  const verbLabel = verb === "enable" ? "Enable 1h now" : "Revert to 5m now";

  let confirmed = args.yes;
  if (!confirmed && interactive) {
    confirmed = await promptYesNo(`${verbLabel}? [y/N] `);
  }
  if (!confirmed) {
    process.stdout.write(
      interactive
        ? "Nothing changed.\n"
        : `(non-interactive: pass --yes to apply: \`cache-cash ${verb} --yes\`)\n`,
    );
    return 0;
  }

  if (verb === "revert") {
    const res = applyRevert({ home: homedir() });
    process.stdout.write(res.message.join("\n") + "\n");
    return 0;
  }

  let summary: Summary | undefined;
  try {
    const r = await run({
      project: args.project,
      days: args.allTime ? null : args.days,
      allTime: args.allTime,
      jsonMode: true,
      overrides: args.overrides,
    });
    summary = r.summary ?? undefined;
  } catch {
    // Analysis failure never blocks the enable itself (baseline is optional).
  }
  const res = applyEnable({ home: homedir(), summary });
  process.stdout.write(res.message.join("\n") + "\n");
  if (res.applied && summary) {
    // High-emotion re-ask moment #1 (standalone `enable` route). Skipped
    // when no Summary exists (empty corpus) — no numbers to fill a template.
    await maybeSharePrompt(summary, true);
  }
  return 0;
}

async function maybeConsentFromEnding(
  args: Args,
  summary: Summary,
  needsConsent: boolean,
  consentVerb: "enable" | "revert" | undefined,
): Promise<number> {
  if (!needsConsent || !consentVerb) return 0;

  // --json never prompts and never reaches here (handled earlier). Non-TTY
  // (piped) also never prompts: print the manual instruction and exit 0 —
  // never prompt when not attached to a TTY.
  const interactive = process.stdout.isTTY && !process.env.CI;
  const verbLabel = consentVerb === "enable" ? "Enable 1h now" : "Revert to 5m now";

  let confirmed = args.yes;
  if (!confirmed && interactive) {
    confirmed = await promptYesNo(`${verbLabel}? [y/N] `);
  }

  if (!confirmed) {
    if (!interactive && !args.yes) {
      process.stdout.write(
        `\n(non-interactive: pass --yes to apply, or run \`cache-cash ${consentVerb}\` from a terminal)\n`,
      );
    }
    return 0;
  }

  const res =
    consentVerb === "enable"
      ? applyEnable({ home: homedir(), summary })
      : applyRevert({ home: homedir() });
  process.stdout.write("\n" + res.message.join("\n") + "\n");
  if (res.applied && consentVerb === "enable") {
    // High-emotion re-ask moment #1: right after a successful enable.
    await maybeSharePrompt(summary, true);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`cache-cash: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(2);
  });
