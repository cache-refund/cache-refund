/**
 * CLI-level tests for the two v1.0.2 flags added on top of the existing
 * argv surface: `--plan <usd>` (documented, subscriber receipt multiplier)
 * and `--branch-override <api-5m|api-1h|subscription>` (hidden dev-only
 * flag — see CONTRIBUTING.md's "Previewing the other endings"). Spawns the
 * real compiled `dist/cli.js` binary (same discipline as
 * cli-standalone.test.ts) so argv parsing, the usage-error exit path, and
 * the actual --json / rendered output are covered end-to-end, not just the
 * render.ts/verdict.ts unit surface.
 *
 * Same real-home safety discipline as the other CLI-spawn test files: every
 * HOME is a fresh mkdtempSync dir, asserted to never coincide with the real
 * account home. Skips (visibly) when dist/cli.js hasn't been built.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "cli.js");

const REAL_ACCOUNT_HOME = (() => {
  try {
    return userInfo().homedir;
  } catch {
    return null;
  }
})();

const tempDirs: string[] = [];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "cache-refund-cli-flags-"));
  if (
    dir.length === 0 ||
    (REAL_ACCOUNT_HOME !== null && (dir === REAL_ACCOUNT_HOME || dir.startsWith(REAL_ACCOUNT_HOME + "/")))
  ) {
    throw new Error("freshHome() produced an unsafe path (" + dir + ") — aborting");
  }
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    if (dir !== REAL_ACCOUNT_HOME) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * Seeds one minimal synthetic transcript, read-heavy enough that
 * uncachedCost > actualCost (a positive absorbedDollars figure — see
 * render.ts): 500K creation5m tokens, 50M read tokens, priced at Sonnet 5's
 * $2/MTok (pricing.ts's exact-match table). No API-provider hints (scrubbed
 * from env by runCli below) and a pure-5m regime, so the UNFORCED branch is
 * "ambiguous" in --json mode — the baseline `--branch-override` tests
 * against.
 */
function seedTranscript(home: string): void {
  const dir = join(home, ".claude", "projects", "p");
  mkdirSync(dir, { recursive: true });
  // Two turns 30 days apart: planMultiplierLine refuses to monthly-normalize a
  // span under a day, so the corpus must cover a real span for the --plan
  // tests (and a 30-day span makes the normalization a clean no-op).
  const now = Date.now();
  const mkLine = (id: string, ts: number) => ({
    timestamp: new Date(ts).toISOString(),
    sessionId: "s1",
    isSidechain: false,
    message: {
      id,
      model: "claude-sonnet-5",
      usage: {
        cache_creation: { ephemeral_5m_input_tokens: 250000, ephemeral_1h_input_tokens: 0 },
        cache_read_input_tokens: 25_000_000,
      },
    },
  });
  const lines = [mkLine("m1", now - 30 * 86400 * 1000), mkLine("m2", now)];
  writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

/** Spawn the real CLI binary with HOME pointed at the synthetic home. CI=1 forces the non-interactive path. */
function runCli(home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CI: "1" };
  delete env.ENABLE_PROMPT_CACHING_1H;
  delete env.FORCE_PROMPT_CACHING_5M;
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const maybe = existsSync(CLI) ? describe : describe.skip;

maybe("--branch-override (hidden dev flag): forces the branch, --json reflects it", () => {
  it("sanity: without the override, this synthetic corpus is honestly ambiguous in --json", () => {
    const home = freshHome();
    seedTranscript(home);
    const r = runCli(home, ["--json"]);
    expect(r.status).toBe(0);
    const summary = JSON.parse(r.stdout);
    expect(summary.branch).toBe("ambiguous");
  });

  for (const branch of ["api-5m", "api-1h", "subscription"] as const) {
    it(`--branch-override ${branch} forces branch:"${branch}" in --json, with the non-interactive evidence bullet`, () => {
      const home = freshHome();
      seedTranscript(home);
      const r = runCli(home, ["--json", "--branch-override", branch]);
      expect(r.status).toBe(0);
      const summary = JSON.parse(r.stdout);
      expect(summary.branch).toBe(branch);
      const evidence: string[] = summary.branchEvidence;
      expect(evidence[evidence.length - 1]).toBe("=> branch override (--branch-override)");
      expect(evidence.join(" ")).not.toContain("answered the interactive branch question");
      expect(evidence.join(" ")).not.toContain("user-confirmed");
    });
  }

  it("invalid value -> clean usage error, exit 2, nothing on stdout (fails before the pipeline runs)", () => {
    const home = freshHome();
    seedTranscript(home);
    const r = runCli(home, ["--json", "--branch-override", "bogus"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("cache-refund:");
    expect(r.stderr).toContain("--branch-override");
    expect(r.stderr).toContain("api-5m");
    expect(r.stdout).toBe("");
  });

  it("missing value -> clean usage error, exit 2", () => {
    const home = freshHome();
    seedTranscript(home);
    const r = runCli(home, ["--branch-override"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--branch-override");
    expect(r.stdout).toBe("");
  });
});

maybe("--plan <usd>: subscription-only receipt multiplier", () => {
  it("renders the absorbed line and the '~Nx your monthly plan' multiplier on the card for a forced-subscription branch", () => {
    const home = freshHome();
    seedTranscript(home);
    const r = runCli(home, ["card", "--branch-override", "subscription", "--plan", "10"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\$[\d,.]+\/mo API-value absorbed/);
    expect(r.stdout).toMatch(/~[\d.]+x your monthly plan, absorbed for free/);
  });

  it("omits the multiplier line for a non-subscription branch, even with --plan set (branch-gated)", () => {
    const home = freshHome();
    seedTranscript(home);
    const r = runCli(home, ["card", "--branch-override", "api-5m", "--plan", "10"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("your monthly plan");
  });

  it("non-positive value -> clean usage error, exit 2", () => {
    const home = freshHome();
    seedTranscript(home);
    const r = runCli(home, ["--plan", "0"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("cache-refund:");
    expect(r.stderr).toContain("--plan");
    expect(r.stdout).toBe("");
  });

  it("negative value -> clean usage error, exit 2", () => {
    const home = freshHome();
    seedTranscript(home);
    const r = runCli(home, ["--plan", "-50"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--plan");
  });

  it("non-numeric value -> clean usage error, exit 2", () => {
    const home = freshHome();
    seedTranscript(home);
    const r = runCli(home, ["--plan", "not-a-number"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--plan");
  });

  it("missing value -> clean usage error, exit 2", () => {
    const home = freshHome();
    seedTranscript(home);
    const r = runCli(home, ["--plan"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--plan");
    expect(r.stdout).toBe("");
  });
});
