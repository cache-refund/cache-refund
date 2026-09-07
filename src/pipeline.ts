/**
 * End-to-end pipeline: discover -> stream-parse -> analyze -> Summary.
 * Streaming, bounded memory: files are parsed one at a time; only TurnEvents
 * (small) accumulate.
 */

import { homedir } from "node:os";
import { discover } from "./discover.js";
import { parseFile, type ParseOptions } from "./parse.js";
import { analyze } from "./analyze.js";
import { buildSummary } from "./verdict.js";
import { readEnvHints } from "./verdict.js";
import type { PriceCtx } from "./costmodel.js";
import type { Branch, Summary, TurnEvent } from "./types.js";

export interface RunOptions {
  project?: string;
  days?: number | null;
  allTime?: boolean;
  jsonMode?: boolean;
  overrides?: Record<string, number>;
  home?: string;
  /** Exact lower timestamp bound for post-change verification (epoch seconds). */
  sinceTs?: number;
  /** See verdict.ts BuildSummaryInput.branchOverride. */
  branchOverride?: Branch;
  /** See verdict.ts BuildSummaryInput.branchOverrideSource. */
  branchOverrideSource?: "interactive" | "flag";
  /**
   * Additive (v1.0.1): live-progress hook for the CLI's in-place scan
   * counter — called after each transcript file finishes parsing with
   * (filesDone, filesTotal). Purely observational: never affects parsing,
   * ordering, or the Summary. Undefined (the default, every existing call
   * site) is a no-op.
   */
  onFileParsed?: (done: number, total: number) => void;
}

export interface RunResult {
  summary: Summary | null;
  fileCount: number;
  /** exit code: 0 ok · 1 no transcripts · 2 handled elsewhere */
  code: 0 | 1 | 2;
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const home = opts.home ?? homedir();
  const { files, projectOf } = discover(opts.project, home);
  if (files.length === 0) {
    return { summary: null, fileCount: 0, code: 1 };
  }

  const allTime = opts.allTime === true;
  const days = allTime ? null : opts.days ?? null;
  const daysCutoff = days != null ? Date.now() / 1000 - days * 86400 : null;
  const cutoff = opts.sinceTs === undefined ? daysCutoff : Math.max(opts.sinceTs, daysCutoff ?? -Infinity);

  const seenIds = new Set<string>();
  const events: TurnEvent[] = [];
  let filesDone = 0;
  for (const file of files) {
    const parseOpts: ParseOptions = {
      cutoff,
      seenIds,
      project: projectOf(file),
    };
    await parseFile(file, parseOpts, events);
    filesDone++;
    opts.onFileParsed?.(filesDone, files.length);
  }

  const agg = analyze(events);
  const hints = readEnvHints(home);
  const ctx: PriceCtx = { overrides: opts.overrides };
  const summary = buildSummary({
    events,
    agg,
    windowMode: allTime ? "all-time" : "days",
    windowDays: days,
    project: opts.project ?? null,
    hints,
    jsonMode: opts.jsonMode === true,
    ctx,
    branchOverride: opts.branchOverride,
    branchOverrideSource: opts.branchOverrideSource,
  });

  return { summary, fileCount: files.length, code: 0 };
}
