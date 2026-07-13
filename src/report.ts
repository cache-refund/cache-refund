import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Summary } from "./types.js";
import type { AccountPlanEvidence } from "./account.js";
import { usagePatternStory } from "./story.js";

export interface DetailedReportOptions {
  home: string;
  now?: Date;
  markdown: string;
}

export type ReportWriteResult =
  | { ok: true; path: string; markdown: string }
  | { ok: false; path: string; markdown: string; error: string };

function timestampForFilename(now: Date): string {
  return now.toISOString().replace(/:/g, "-").replace(".", "-");
}

export function reportPath(home: string, now: Date = new Date()): string {
  return join(home, ".claude", "cache-refund", "reports", `${timestampForFilename(now)}.md`);
}

export function detailedReportMarkdown(summary: Summary, baseMarkdown: string, account: AccountPlanEvidence): string {
  const plan = account.kind === "recognized"
    ? `${account.name} ($${account.monthlyUsd}/month)`
    : account.kind === "subscription"
      ? `${account.name} (price unknown)`
      : account.kind === "stale"
        ? `${account.name} (cached plan metadata is stale)`
        : "No recognized local plan metadata";
  return `${baseMarkdown}\n\n## Usage pattern\n\n${usagePatternStory(summary).text}\n\n## Local plan classification\n\n${plan}\n`;
}

export function writeDetailedReport(_summary: Summary, opts: DetailedReportOptions): ReportWriteResult {
  const now = opts.now ?? new Date();
  const path = reportPath(opts.home, now);
  const directory = join(opts.home, ".claude", "cache-refund", "reports");
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, opts.markdown, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    return { ok: true, path, markdown: opts.markdown };
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    return { ok: false, path, markdown: opts.markdown, error: error instanceof Error ? error.message : String(error) };
  }
}
