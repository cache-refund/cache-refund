/**
 * CLI-level tests for the standalone enable/revert path: `enable` and
 * `revert` are first-class subcommands and must work in a HOME with ZERO
 * transcripts — the settings edit needs no Summary. They must not be
 * reachable only behind main()'s "No transcripts found" pipeline gate.
 *
 * These tests spawn the real compiled `dist/cli.js` binary under a synthetic
 * HOME, covering the exact flow a user's `npx @m8t-labs/cache-cash enable --yes`
 * takes — argv parsing, the early route in main(), consent gating — not
 * just the actions.ts unit surface (test/actions.test.ts covers that).
 *
 * Same real-home safety discipline as actions.test.ts: every HOME is a
 * fresh mkdtempSync dir under os.tmpdir(), asserted to never coincide with
 * the real account home (from the OS user database, HOME-env-independent).
 *
 * Skips (visibly) when dist/cli.js hasn't been built — the repo gate is
 * `npm run build && npm test`, so it exists in any gate run; a bare
 * `npm test` on a fresh clone skips these rather than failing confusingly.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "cachecash-cli-"));
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

function settingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}
function backupPath(home: string): string {
  return join(home, ".claude", "settings.json.cache-cash.bak");
}
function baselinePath(home: string): string {
  return join(home, ".claude", "cache-cash.json");
}

function seedSettings(home: string, obj: unknown): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsPath(home), JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/** Spawn the real CLI binary with HOME pointed at the synthetic home. CI=1 forces the non-interactive path. */
function runCli(home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CI: "1" };
  // Scrub ambient cache flags so branch/refuse logic in the child is
  // deterministic regardless of the developer machine's environment.
  delete env.ENABLE_PROMPT_CACHING_1H;
  delete env.FORCE_PROMPT_CACHING_5M;
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const maybe = existsSync(CLI) ? describe : describe.skip;

maybe("standalone enable/revert route before the pipeline (no transcripts required)", () => {
  it("enable --yes succeeds end-to-end in an empty-transcript HOME (settings written)", () => {
    const home = freshHome();
    // No .claude dir, no projects, no transcripts — the previously-broken case.
    const r = runCli(home, ["enable", "--yes"]);

    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("No transcripts found");
    expect(existsSync(settingsPath(home))).toBe(true);
    const j = JSON.parse(readFileSync(settingsPath(home), "utf8"));
    expect((j.env as Record<string, unknown>).ENABLE_PROMPT_CACHING_1H).toBe("1");
    // No prior file existed -> no backup fabricated, and no baseline (no
    // transcripts to compute one from — it's optional convenience data).
    expect(existsSync(backupPath(home))).toBe(false);
    expect(existsSync(baselinePath(home))).toBe(false);
    expect(r.stdout).toContain("NEXT session");
  });

  it("enable --yes with an existing settings.json (still no transcripts) adds the flag and creates the backup", () => {
    const home = freshHome();
    const original = { model: "opus[1m]", env: { KEEP: "me" } };
    seedSettings(home, original);

    const r = runCli(home, ["enable", "--yes"]);

    expect(r.status).toBe(0);
    const j = JSON.parse(readFileSync(settingsPath(home), "utf8"));
    expect(j.model).toBe("opus[1m]");
    expect((j.env as Record<string, unknown>).KEEP).toBe("me");
    expect((j.env as Record<string, unknown>).ENABLE_PROMPT_CACHING_1H).toBe("1");
    expect(existsSync(backupPath(home))).toBe(true);
    expect(JSON.parse(readFileSync(backupPath(home), "utf8"))).toEqual(original);
  });

  it("revert --yes succeeds end-to-end in an empty-transcript HOME (flag removed, backup created)", () => {
    const home = freshHome();
    seedSettings(home, { model: "opus[1m]", env: { ENABLE_PROMPT_CACHING_1H: "1", KEEP: "me" } });

    const r = runCli(home, ["revert", "--yes"]);

    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("No transcripts found");
    const j = JSON.parse(readFileSync(settingsPath(home), "utf8"));
    expect((j.env as Record<string, unknown>).ENABLE_PROMPT_CACHING_1H).toBeUndefined();
    expect((j.env as Record<string, unknown>).KEEP).toBe("me");
    expect(existsSync(backupPath(home))).toBe(true);
  });

  it("enable WITHOUT --yes in a non-interactive run writes NOTHING (the one write is always confirmed)", () => {
    const home = freshHome();
    seedSettings(home, { model: "opus[1m]" });
    const before = readFileSync(settingsPath(home), "utf8");

    const r = runCli(home, ["enable"]);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--yes");
    expect(readFileSync(settingsPath(home), "utf8")).toBe(before);
    expect(existsSync(backupPath(home))).toBe(false);
  });

  it("enable --json never writes and keeps the pipeline path (empty HOME -> no-transcripts exit 1, no settings created)", () => {
    const home = freshHome();

    const r = runCli(home, ["enable", "--json", "--yes"]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No transcripts found");
    expect(existsSync(settingsPath(home))).toBe(false);
  });

  it("verify in an empty HOME errors with a helpful no-transcripts message, exit code 1", () => {
    const home = freshHome();

    const r = runCli(home, ["verify"]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No transcripts found");
  });

  it("recheck in an empty HOME errors the same way (needs transcripts), exit code 1", () => {
    const home = freshHome();

    const r = runCli(home, ["recheck"]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No transcripts found");
  });

  it("enable --yes STILL writes the recheck baseline when transcripts exist (no regression from the early route)", () => {
    const home = freshHome();
    const dir = join(home, ".claude", "projects", "p");
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const line = {
      timestamp: now,
      sessionId: "s1",
      isSidechain: false,
      message: {
        id: "m1",
        model: "claude-sonnet-5",
        usage: {
          cache_creation: { ephemeral_5m_input_tokens: 500000, ephemeral_1h_input_tokens: 0 },
          cache_read_input_tokens: 100000,
        },
      },
    };
    writeFileSync(join(dir, "s1.jsonl"), JSON.stringify(line) + "\n", "utf8");

    const r = runCli(home, ["enable", "--yes"]);

    expect(r.status).toBe(0);
    const j = JSON.parse(readFileSync(settingsPath(home), "utf8"));
    expect((j.env as Record<string, unknown>).ENABLE_PROMPT_CACHING_1H).toBe("1");
    expect(existsSync(baselinePath(home))).toBe(true);
    const baseline = JSON.parse(readFileSync(baselinePath(home), "utf8"));
    expect(typeof baseline.enabled_at).toBe("string");
    expect(r.stdout).toContain("Baseline saved");
  });
});
