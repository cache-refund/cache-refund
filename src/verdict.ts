/**
 * Branch detection + TTL reality check + Summary assembly.
 *
 * Branch detection inputs:
 *   - ~/.claude/settings.json env: ENABLE_PROMPT_CACHING_1H, FORCE_PROMPT_CACHING_5M
 *   - provider hints: CLAUDE_CODE_USE_BEDROCK / _USE_VERTEX, ANTHROPIC_API_KEY
 *   - per-period 1h/5m creation split from transcripts (the regime)
 *   - if still ambiguous: caller asks one question interactively; in --json
 *     mode we report branch:"ambiguous" instead of asking.
 *
 * Official rule: subscribers receive 1h automatically; ENABLE_PROMPT_CACHING_1H
 * is API/Bedrock/Vertex/Foundry-only. So: 1h regime + no explicit env flag +
 * no API-provider hint => subscription. 5m regime + API hint => api-5m. etc.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Aggregate } from "./analyze.js";
import { recoverableRatio } from "./analyze.js";
import {
  biggestMissAndWorstDay,
  counterfactual,
  efficiencyScore,
  leakRows,
  perModelTotals,
  wrappedStats,
  type PriceCtx,
} from "./costmodel.js";
import { THRESHOLD } from "./pricing.js";
import type { Branch, Regime, Summary, TurnEvent, TtlRealityCheck } from "./types.js";
import { readAccountPlan } from "./account.js";

export interface EnvHints {
  enable1h: boolean;
  force5m: boolean;
  useBedrock: boolean;
  useVertex: boolean;
  hasApiKey: boolean;
  /** true if we could read settings.json at all. */
  settingsFound: boolean;
  accountSubscription?: boolean;
  accountEvidence?: string[];
}

/** Read env-relevant hints from ~/.claude/settings.json (+ process env). */
export function readEnvHints(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): EnvHints {
  let enable1h = false;
  let force5m = false;
  let useBedrock = false;
  let useVertex = false;
  let hasApiKey = false;
  let settingsFound = false;

  try {
    const raw = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    settingsFound = true;
    const j = JSON.parse(raw) as { env?: Record<string, unknown> };
    const e = j.env ?? {};
    const truthy = (v: unknown) => v === "1" || v === 1 || v === true || v === "true";
    if (truthy(e["ENABLE_PROMPT_CACHING_1H"])) enable1h = true;
    if (truthy(e["FORCE_PROMPT_CACHING_5M"])) force5m = true;
    if (truthy(e["CLAUDE_CODE_USE_BEDROCK"])) useBedrock = true;
    if (truthy(e["CLAUDE_CODE_USE_VERTEX"])) useVertex = true;
    if (typeof e["ANTHROPIC_API_KEY"] === "string" && (e["ANTHROPIC_API_KEY"] as string).length > 0)
      hasApiKey = true;
  } catch {
    // no settings.json — fall through to process env
  }

  // Process env can also carry these (Claude Code reads them at runtime).
  const penv = (k: string) => typeof env[k] === "string" && env[k]!.length > 0;
  if (env["ENABLE_PROMPT_CACHING_1H"] === "1") enable1h = true;
  if (env["FORCE_PROMPT_CACHING_5M"] === "1") force5m = true;
  if (env["CLAUDE_CODE_USE_BEDROCK"] === "1") useBedrock = true;
  if (env["CLAUDE_CODE_USE_VERTEX"] === "1") useVertex = true;
  if (penv("ANTHROPIC_API_KEY")) hasApiKey = true;

  const account = readAccountPlan(home);
  const accountSubscription = account.kind === "recognized" || account.kind === "subscription";
  return { enable1h, force5m, useBedrock, useVertex, hasApiKey, settingsFound, accountSubscription, accountEvidence: account.evidence };
}

export interface BranchResult {
  branch: Branch;
  evidence: string[];
}

/** Decide the billing branch from env hints + observed regime. */
export function detectBranch(hints: EnvHints, regime: Regime, jsonMode: boolean): BranchResult {
  const ev: string[] = [];
  const apiProvider = hints.useBedrock || hints.useVertex || hints.hasApiKey;

  if (hints.useBedrock) ev.push("CLAUDE_CODE_USE_BEDROCK set (API/Bedrock billing)");
  if (hints.useVertex) ev.push("CLAUDE_CODE_USE_VERTEX set (API/Vertex billing)");
  if (hints.hasApiKey) ev.push("ANTHROPIC_API_KEY present (API billing)");
  if (hints.accountSubscription) ev.push(...(hints.accountEvidence ?? ["local account metadata indicates subscription billing"]));
  if (hints.enable1h) ev.push("ENABLE_PROMPT_CACHING_1H=1 in settings (opted into 1h)");
  if (hints.force5m) ev.push("FORCE_PROMPT_CACHING_5M=1 in settings (pinned to 5m)");
  ev.push(`observed write regime: ${regime}`);

  // Explicit API-provider signal => an API branch. Regime picks 5m vs 1h.
  if (apiProvider) {
    if (hints.force5m || regime === "5m") {
      ev.push("=> API-billed, receiving 5m");
      return { branch: "api-5m", evidence: ev };
    }
    if (hints.enable1h || regime === "1h") {
      ev.push("=> API-billed, receiving 1h (opted in)");
      return { branch: "api-1h", evidence: ev };
    }
    // API but no cache activity: ambiguous which TTL.
    ev.push("=> API-billed, TTL undetermined");
    return { branch: jsonMode ? "ambiguous" : "api-5m", evidence: ev };
  }

  if (hints.accountSubscription) {
    ev.push(
      hints.enable1h
        ? "=> subscription (recognized local account metadata; ignoring provider-less 1h flag)"
        : "=> subscription (recognized local account metadata)",
    );
    return { branch: "subscription", evidence: ev };
  }

  // No API-provider or subscription signal. The 1h flag is API-only, so if
  // it's set here we lean API (the user may set the key via keychain/helper).
  if (hints.enable1h) {
    ev.push("=> 1h flag set without provider hint; treating as API-billed on 1h");
    return { branch: "api-1h", evidence: ev };
  }

  // Subscribers get 1h automatically and cannot set the flag. A 1h regime with
  // no provider hint and no flag is the canonical subscription signature.
  if (regime === "1h") {
    ev.push("=> subscription (1h auto-active, no API provider hint, no 1h flag)");
    return { branch: "subscription", evidence: ev };
  }

  // 5m regime, no provider hint: could be a subscriber whose writes are mostly
  // sidechain/5m, or an API user on the default. Ambiguous in --json; otherwise
  // the CLI asks one question.
  ev.push("=> ambiguous (5m regime, no provider hint)");
  return { branch: jsonMode ? "ambiguous" : "subscription", evidence: ev };
}

/** TTL reality check on the most-recent `windowDays` of turns. */
export function ttlRealityCheck(events: TurnEvent[], windowDays: number, lastTs: number | null): TtlRealityCheck {
  let creation5m = 0;
  let creation1h = 0;
  if (lastTs !== null) {
    const cutoff = lastTs - windowDays * 86400;
    for (const ev of events) {
      if (ev.ts >= cutoff) {
        creation5m += ev.c5;
        creation1h += ev.c1;
      }
    }
  }
  let regime: Regime;
  let received: string;
  if (creation1h === 0 && creation5m === 0) {
    regime = "none";
    received = "no cache writes";
  } else if (creation1h > creation5m) {
    regime = "1h";
    received = "1h";
  } else {
    regime = "5m";
    received = "5m";
  }
  return { windowDays, regime, creation5m, creation1h, received };
}

export interface BuildSummaryInput {
  events: TurnEvent[];
  agg: Aggregate;
  windowMode: "days" | "all-time";
  windowDays: number | null;
  project: string | null;
  hints: EnvHints;
  jsonMode: boolean;
  ctx?: PriceCtx;
  /**
   * Additive, backward-compatible field: when the CLI has already resolved
   * an "ambiguous" branch via its one interactive question ("subscription or
   * API?"), it passes the user's confirmed answer here so buildSummary skips
   * detectBranch's guess entirely. Branch detection logic itself stays owned
   * by verdict.ts (this file) — the CLI never re-derives it, it only
   * supplies the human's direct answer when the analyzer itself couldn't
   * decide. Undefined (the default) preserves all existing detectBranch
   * behavior byte-for-byte.
   */
  branchOverride?: Branch;
  /**
   * Provenance of `branchOverride`, for the evidence trail's final bullet.
   * "interactive" (the default when unset — preserves the pre-existing
   * behavior byte-for-byte): the CLI's one-question ambiguous-branch prompt
   * (cli.ts's promptBranch); evidence says "user-confirmed ... answered the
   * interactive branch question", because that's literally what happened.
   * "flag": the hidden `--branch-override` dev flag (a QA/screenshot tool —
   * see CONTRIBUTING.md's "Previewing the other endings"), which force-picks
   * a branch WITHOUT the user ever answering that question; evidence instead
   * says "branch override (--branch-override)" so the trail never claims an
   * interaction that never happened.
   */
  branchOverrideSource?: "interactive" | "flag";
}

const DAY_S = 86400;

/** Assemble the full Summary from analysis + env. */
export function buildSummary(input: BuildSummaryInput): Summary {
  const { events, agg, windowMode, windowDays, project, hints, jsonMode } = input;
  const ctx = input.ctx ?? {};

  const spanDays =
    agg.firstTs !== null && agg.lastTs !== null
      ? Math.max((agg.lastTs - agg.firstTs) / DAY_S, 0)
      : 0;

  const ratio = recoverableRatio(agg.buckets);
  const branch = input.branchOverride
    ? {
        branch: input.branchOverride,
        evidence: [
          ...detectBranch(hints, agg.regime, jsonMode).evidence,
          input.branchOverrideSource === "flag"
            ? `=> branch override (--branch-override)`
            : `=> user-confirmed: ${input.branchOverride} (answered the interactive branch question)`,
        ],
      }
    : detectBranch(hints, agg.regime, jsonMode);

  // Reality check window: min(7, requested) so it reflects the *recent* regime.
  const realityWindow = windowDays !== null ? Math.min(7, windowDays) : 7;
  const reality = ttlRealityCheck(events, realityWindow, agg.lastTs);

  const { rows: perModel, unknown } = perModelTotals(agg.annotated, ctx);

  // Total 5m+1h write spend across models (for leak-row shares).
  const totalWriteSpend = writeSpend(agg, ctx);

  const leaks = leakRows(agg.annotated, totalWriteSpend, ctx);
  const cf = counterfactual(agg.annotated, spanDays, ctx);
  const { biggestMiss, worstDay } = biggestMissAndWorstDay(agg.annotated, ctx);
  const wrapped = wrappedStats(agg.annotated);
  const score = efficiencyScore(agg.annotated, leaks, ctx);

  const currency =
    branch.branch === "subscription"
      ? "USD-equivalent (API list rates)"
      : "USD";

  return {
    summaryVersion: 1,
    scoreVersion: 1,
    window: {
      mode: windowMode,
      days: windowDays,
      firstTs: agg.firstTs,
      lastTs: agg.lastTs,
      spanDays,
    },
    scope: { project, sessions: agg.sessions, turns: agg.turns },
    branch: branch.branch,
    branchEvidence: branch.evidence,
    regime: agg.regime,
    ttlRealityCheck: reality,
    buckets: agg.buckets,
    tokens: {
      creationTotal: agg.buckets.creationTotal,
      creation5m: agg.totals.creation5m,
      creation1h: agg.totals.creation1h,
      readTotal: agg.totals.read,
    },
    recoverableRatio: ratio,
    threshold: THRESHOLD,
    aboveThreshold: ratio > THRESHOLD,
    perModel,
    unknownModels: unknown,
    leaks,
    counterfactual: cf,
    efficiencyScore: score,
    biggestMiss,
    worstDay,
    wrapped,
    currency,
  };
}

/** Total 5m+1h write spend across models at per-model rates. */
function writeSpend(agg: Aggregate, ctx: PriceCtx): number {
  // Sum per-turn write cost (excludes reads).
  const { rows } = perModelTotals(agg.annotated, ctx);
  let total = 0;
  for (const r of rows) {
    const P = r.basePrice / 1_000_000;
    total += r.creation5m * 1.25 * P + r.creation1h * 2.0 * P;
  }
  return total;
}
