#!/usr/bin/env node
/**
 * The full CLI surface.
 *
 *   npx cache-refund                 full checkup
 *   npx cache-refund card            score box + top Wrapped line
 *   npx cache-refund enable          confirmed 1h-TTL enable flow
 *   npx cache-refund revert          confirmed 5m-TTL revert flow
 *   npx cache-refund verify          post-enable TTL check
 *   npx cache-refund recheck         baseline comparison
 *
 *   --days N (90) · --project <path> · --price <model=$/MTok,...> · --yes ·
 *   --no-color · --all-time · --json · --md · --compact · --explain ·
 *   --projects (v1.0.1: opt back into project names in human output;
 *               default is share-safe — no project names in screenshots)
 *   --no-share (v1.0.2: silence the share prompt; same as env
 *               CACHE_REFUND_NO_SHARE=1 — see maybeSharePrompt)
 *   --plan <usd> (v1.0.2: monthly subscription price; subscription branch
 *               only — renders "~Nx your monthly plan, absorbed for free"
 *               on the receipt/card/SVG. Non-positive/non-numeric -> usage
 *               error, exit 2. See render.ts's planMultiplierLine.)
 *
 * Also: --branch-override <api-5m|api-1h|subscription> — a HIDDEN dev-only
 * flag (not in this list on purpose: not for README, not for users). Forces
 * the billing branch on your REAL corpus numbers, for previewing the other
 * endings without needing three different machines. See CONTRIBUTING.md's
 * "Previewing the other endings" and verdict.ts's BuildSummaryInput.branchOverride.
 *
 * Exit codes: 0 ok · 1 no transcripts found · 2 parse/usage/internal error.
 * `--json` never prompts.
 *
 * TTY-ness is decided ONCE, here, up front, and threaded through every
 * render call as `opts.tty` — render.ts and format.ts never call
 * process.stdout.isTTY themselves.
 */

import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { run } from "./pipeline.js";
import { parsePriceOverride } from "./pricing.js";
import { applyEnable, applyRevert, runRecheck, runVerify } from "./actions.js";
import {
  bskyIntentUrl,
  copyImageToClipboard,
  copyToClipboard,
  noShareEnvSet,
  openExternal,
  revealFile,
  runLinkedInShare,
  xIntentUrl,
} from "./share.js";
import { writeCardImage } from "./cardimage.js";
import { readAccountPlan } from "./account.js";
import { parseConfirmation } from "./consent.js";
import { readFinalActionKey } from "./keymenu.js";
import { detailedReportMarkdown, writeDetailedReport, type ReportWriteResult } from "./report.js";
import {
  checkupLines,
  decideEnding,
  makeScanProgress,
  pickLoadingPun,
  renderAmbiguousNotice,
  renderCard,
  renderCompact,
  renderEnding,
  renderExplain,
  renderFull,
  renderMarkdown,
  shareTemplate,
  trustLine,
} from "./render.js";
import { makeInk, makeSym } from "./format.js";
import type { Branch, Summary } from "./types.js";

// ------------------------------------------------------------------ argv

type Subcommand = "checkup" | "card" | "enable" | "revert" | "verify" | "recheck" | "share";

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
  /**
   * --no-share (v1.0.2): silence maybeSharePrompt entirely (no prompt line,
   * no "share anytime" hint) — same effect as env CACHE_REFUND_NO_SHARE
   * (see share.ts's noShareEnvSet). The share prompt itself has no other
   * frequency guard: it appears on every interactive checkup end, so this
   * flag is the standing opt-out.
   */
  noShare: boolean;
  /**
   * --plan <usd> (v1.0.2): monthly subscription price, USD. Display-only —
   * never affects any computed figure, only whether the "~Nx your monthly
   * plan, absorbed for free" line renders (subscription branch only; see
   * render.ts's planMultiplierLine). Validated at parse time: non-positive
   * or non-numeric is a usage error (UsageError below), not a silent ignore
   * — unlike most flags here, a wrong --plan value would silently mislabel
   * a real dollar comparison, so it fails loud instead.
   */
  plan?: number;
  /**
   * --branch-override <api-5m|api-1h|subscription> (v1.0.2): HIDDEN dev-only
   * flag, not documented in README (see this file's top comment and
   * CONTRIBUTING.md's "Previewing the other endings"). Forces buildSummary's
   * existing branchOverride seam — see verdict.ts — from the CLI instead of
   * from the interactive ambiguous-branch question, so a maintainer can
   * preview any of the three endings against their OWN real corpus for
   * screenshots/QA. Validated at parse time like --plan.
   */
  branchOverride?: Branch;
}

const SUBCOMMANDS = new Set<Subcommand>(["card", "enable", "revert", "verify", "recheck", "share"]);
const BRANCH_OVERRIDE_VALUES: ReadonlySet<Branch> = new Set(["api-5m", "api-1h", "subscription"]);

/**
 * A clean, stack-trace-free CLI usage error: caught in main(), printed as
 * `cache-refund: <message>` on stderr, exit 2 — never the generic top-level
 * catch-all (which prints err.stack, appropriate for a genuine bug, not a
 * typo'd flag value).
 */
class UsageError extends Error {}

function describeArg(raw: string | undefined): string {
  return raw === undefined ? "nothing" : JSON.stringify(raw);
}

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
    noShare: false,
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
      case "--no-share":
        args.noShare = true;
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
      case "--plan": {
        const raw = argv[++i];
        const v = Number(raw);
        if (raw === undefined || !Number.isFinite(v) || v <= 0) {
          throw new UsageError(`--plan requires a positive USD amount, e.g. --plan 200 (got ${describeArg(raw)})`);
        }
        args.plan = v;
        break;
      }
      case "--branch-override": {
        const raw = argv[++i];
        if (raw === undefined || !BRANCH_OVERRIDE_VALUES.has(raw as Branch)) {
          throw new UsageError(
            `--branch-override must be one of api-5m, api-1h, subscription (got ${describeArg(raw)})`,
          );
        }
        args.branchOverride = raw as Branch;
        break;
      }
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
function promptYesNo(question: string, defaultYes = false): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(parseConfirmation(answer, defaultYes));
    });
  });
}

function resolvedPlanPrice(args: Args): number | undefined {
  if (args.plan !== undefined) return args.plan;
  const account = readAccountPlan(homedir());
  return account.kind === "recognized" ? account.monthlyUsd : undefined;
}

function resolvedPlanName(): string | undefined {
  const account = readAccountPlan(homedir());
  return account.kind === "recognized" ? account.name : undefined;
}

function reportMarkdown(summary: Summary): string {
  return detailedReportMarkdown(summary, renderMarkdown(summary), readAccountPlan(homedir()));
}

async function finalActionMenu(
  summary: Summary,
  noShare: boolean,
  planPrice: number | undefined,
  report: ReportWriteResult,
): Promise<void> {
  if (noShare || noShareEnvSet() || !process.stdout.isTTY || process.env.CI) return;
  let image: ReturnType<typeof writeCardImage>;
  try {
    image = writeCardImage(summary, { planPrice, planName: resolvedPlanName() });
  } catch {
    process.stdout.write("\n(couldn't generate the card image)\n");
    return;
  }
  const imagePath = image.pngPath ?? image.svgPath;
  process.stdout.write(
    "\nReady to share — press Enter to copy the card image\n\n" +
      "  [Enter] Copy card image\n" +
      "  [r]     Copy detailed report\n" +
      "  [s]     Show card/report file locations\n" +
      "  [x]     Post to X\n" +
      "  [b]     Post to Bluesky\n" +
      "  [l]     Post to LinkedIn\n" +
      "  [q/Esc] Finish without copying\n",
  );
  const action = await readFinalActionKey(process.stdin);
  process.stdout.write("\n");
  if (action === "quit") return;
  if (action === "show-paths") {
    process.stdout.write(`card: ${imagePath}\nreport: ${report.path}\n`);
    return;
  }
  if (action === "copy-report") {
    const copied = await copyToClipboard(report.markdown);
    process.stdout.write(copied ? "detailed report copied to clipboard\n" : `couldn't copy report — saved at ${report.path}\n`);
    return;
  }
  const text = shareTemplate(summary, "checkup");
  if (action === "linkedin") {
    await runLinkedInShare(text, imagePath, {
      copyToClipboard,
      revealFile,
      openExternal,
      write: (message) => process.stdout.write(message),
    });
    return;
  }
  const clipped = image.pngPath ? await copyImageToClipboard(image.pngPath) : false;
  process.stdout.write(clipped ? "card image copied to clipboard\n" : `card image saved at ${imagePath}\n`);
  if (action === "copy-image") return;
  const url = action === "x" ? xIntentUrl(text) : bskyIntentUrl(text);
  if (!(await openExternal(url))) process.stdout.write(`couldn't launch a browser — open this yourself:\n${url}\n`);
}

/** The one interactive branch-ambiguity question: "subscription or API/Bedrock/Vertex?". */
function promptBranch(): Promise<Branch> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      "cache-refund: couldn't tell how you pay from transcripts or settings.\n" +
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
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`cache-refund: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  const tty = isInteractiveTty(args);
  const color = useColor(args, tty);
  const ink = makeInk(color);
  // ascii-ness tracks TTY-ness only (non-TTY/CI -> ASCII), never --no-color
  // on its own — --no-color strips color but keeps Unicode box chars on a
  // real TTY, per RenderOptions.noColor's "independent of TTY" doc.
  const sym = makeSym(!tty);

  // enable/revert are first-class subcommands and must work in a HOME with
  // zero transcripts — the settings edit needs no Summary. Route them BEFORE
  // the analysis pipeline. --json is exempt: `cache-refund enable --json` is a
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
    // Hidden dev flag (see Args.branchOverride): forces the branch on the
    // REAL corpus below, before the ambiguous-branch check even runs — the
    // interactive question never fires when this is set (branch is never
    // "ambiguous" once overridden).
    branchOverride: args.branchOverride,
    branchOverrideSource: args.branchOverride ? "flag" : undefined,
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
  const planPrice = resolvedPlanPrice(args);
  const opts = { tty: renderOpts.tty, noColor: !renderOpts.color, showProjects: args.projects, planPrice, planName: resolvedPlanName() };
  const persistReport = () => writeDetailedReport(summary, { home: homedir(), markdown: reportMarkdown(summary) });

  // --json always wins (stable machine-readable schema).
  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }

  switch (args.subcommand) {
    case "card":
      process.stdout.write(renderCard(summary, opts) + "\n");
      persistReport();
      return 0;

    case "share":
      process.stdout.write(renderCard(summary, opts) + "\n");
      await finalActionMenu(summary, args.noShare, planPrice, persistReport());
      return 0;

    // "enable" / "revert" never reach this switch: non-json runs are
    // early-routed to runStandaloneAction() in main() BEFORE the pipeline
    // (they must work without transcripts), and --json runs return via the
    // JSON dump above. Keeping a single standalone write path (with its
    // consent gate) avoids a second, unguarded route to applyEnable.

    case "verify": {
      const res = await runVerify({ home: homedir() });
      process.stdout.write(res.message.join("\n") + "\n");
      persistReport();
      return 0;
    }

    case "recheck": {
      const res = await runRecheck({ home: homedir() });
      process.stdout.write(res.message.join("\n") + "\n");
      const report = persistReport();
      if ((res.savedSinceEnable ?? 0) > 0) {
        await finalActionMenu(summary, args.noShare, planPrice, report);
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
  opts: { tty: boolean; noColor: boolean; planPrice?: number },
): Promise<number> {
  if (args.md) {
    process.stdout.write(renderMarkdown(summary) + "\n");
    writeDetailedReport(summary, { home: homedir(), markdown: reportMarkdown(summary) });
    return 0;
  }
  if (args.compact) {
    process.stdout.write(renderCompact(summary, opts) + "\n");
    writeDetailedReport(summary, { home: homedir(), markdown: reportMarkdown(summary) });
    return 0;
  }
  if (args.explain) {
    process.stdout.write(renderExplain(summary) + "\n");
    writeDetailedReport(summary, { home: homedir(), markdown: reportMarkdown(summary) });
    return 0;
  }

  if (!opts.tty) {
    // Plain ASCII, no stagger, no in-place updates, single shot.
    const full = renderFull(summary, opts);
    process.stdout.write(full.lines.join("\n") + "\n");
    writeDetailedReport(summary, { home: homedir(), markdown: reportMarkdown(summary) });
    return await maybeConsentFromEnding(args, summary, full.needsConsent, full.consentVerb);
  }

  const ink = makeInk(!opts.noColor);
  // Reached only when opts.tty is true (see the !opts.tty branch above), so
  // this is always the Unicode table — ascii-ness tracks TTY-ness.
  const sym = makeSym(false);
  await staggerPrint(checkupLines(summary, ink, sym));
  const kind = decideEnding(summary);
  const ending = renderEnding(summary, kind, ink, sym, opts.planPrice);
  process.stdout.write("\n" + ending.lines.join("\n") + "\n");

  const code = await maybeConsentFromEnding(args, summary, ending.needsConsent, ending.consentVerb);
  const report = writeDetailedReport(summary, { home: homedir(), markdown: reportMarkdown(summary) });
  process.stdout.write(report.ok ? `\nDetailed report saved to ${report.path}\n` : `\nWarning: couldn't save detailed report (${report.error})\n`);
  process.stdout.write("\n" + renderCard(summary, opts) + "\n");
  await finalActionMenu(summary, args.noShare, opts.planPrice, report);
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
 * Standalone `cache-refund enable` / `cache-refund revert` (first-class
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
  const verbLabel = verb === "enable" ? "Switch to the 1-hour cache" : "Revert to the 5-minute cache";

  let confirmed = args.yes;
  if (!confirmed && interactive) {
    confirmed = await promptYesNo(`${verbLabel}? ${verb === "enable" ? "[Y/n]" : "[y/N]"} `, verb === "enable");
  }
  if (!confirmed) {
    process.stdout.write(
      interactive
        ? "Nothing changed.\n"
        : `(non-interactive: pass --yes to apply: \`cache-refund ${verb} --yes\`)\n`,
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
      branchOverride: args.branchOverride,
      branchOverrideSource: args.branchOverride ? "flag" : undefined,
    });
    summary = r.summary ?? undefined;
  } catch {
    // Analysis failure never blocks the enable itself (baseline is optional).
  }
  const res = applyEnable({ home: homedir(), summary });
  process.stdout.write(res.message.join("\n") + "\n");
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
  const monthly = Math.abs(summary.counterfactual.delta30d);
  const verbLabel = consentVerb === "enable"
    ? `Switch to the 1-hour cache and save about $${monthly.toFixed(2)}/month`
    : `Revert to the 5-minute cache and save about $${monthly.toFixed(2)}/month`;

  let confirmed = args.yes;
  if (!confirmed && interactive) {
    const defaultYes = consentVerb === "enable";
    confirmed = await promptYesNo(`${verbLabel}? ${defaultYes ? "[Y/n]" : "[y/N]"} `, defaultYes);
  }

  if (!confirmed) {
    if (!interactive && !args.yes) {
      process.stdout.write(
        `\n(non-interactive: pass --yes to apply, or run \`cache-refund ${consentVerb}\` from a terminal)\n`,
      );
    }
    return 0;
  }

  const res =
    consentVerb === "enable"
      ? applyEnable({ home: homedir(), summary })
      : applyRevert({ home: homedir() });
  process.stdout.write("\n" + res.message.join("\n") + "\n");
  return 0;
}

// ------------------------------------------------------------- entrypoint
// Run only when executed directly (`node dist/cli.js`, the npm bin shim,
// `npx cache-refund`) — never on import, so tests can reach the interactive
// code paths without spawning the CLI as a side effect. The realpath step is
// load-bearing: the npm bin entry is a symlink to dist/cli.js, and node
// resolves the main module's import.meta.url through symlinks, so comparing
// against a realpath'd argv[1] keeps the shim matching. If realpath fails
// (argv[1] missing or unreadable), fall back to the raw path comparison.
const entryHref = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return null;
  try {
    return pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return pathToFileURL(argv1).href;
  }
})();

if (entryHref === import.meta.url) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`cache-refund: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(2);
    });
}
