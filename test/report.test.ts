import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detailedReportMarkdown, reportPath, writeDetailedReport } from "../src/report.js";
import { fixtureEndingCReceipt } from "./fixtures/summaries.js";
import { fixtureEndingAEnable } from "./fixtures/summaries.js";

describe("detailed report persistence", () => {
  it("uses a filesystem-safe UTC timestamp under the cache-refund reports directory", () => {
    expect(reportPath("/home/alice", new Date("2026-07-13T14:32:08.456Z"))).toBe(
      "/home/alice/.claude/cache-refund/reports/2026-07-13T14-32-08-456Z.md",
    );
  });

  it("writes the supplied aggregate markdown with owner-only permissions", () => {
    const home = mkdtempSync(join(tmpdir(), "cache-refund-report-"));
    const result = writeDetailedReport(fixtureEndingAEnable, {
      home,
      now: new Date("2026-07-13T14:32:08.456Z"),
      markdown: "# aggregate report\n\nNo content.\n",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(readFileSync(result.path, "utf8")).toBe("# aggregate report\n\nNo content.\n");
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
  });

  it("returns a warning result instead of throwing when persistence fails", () => {
    const result = writeDetailedReport(fixtureEndingAEnable, {
      home: "/dev/null/not-a-home",
      now: new Date("2026-07-13T14:32:08.456Z"),
      markdown: "report",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.path).toContain("cache-refund/reports");
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("adds the aggregate usage story and safe plan classification", () => {
    const markdown = detailedReportMarkdown(fixtureEndingCReceipt, "# base", {
      kind: "recognized",
      name: "Max 20x",
      monthlyUsd: 200,
      fresh: true,
      evidence: ["rate-limit tier: default_claude_max_20x"],
    });
    expect(markdown).toContain("## Usage pattern");
    expect(markdown).toContain("long-running sessions");
    expect(markdown).toContain("Max 20x ($200/month)");
    expect(markdown).not.toContain("email");
  });
});
