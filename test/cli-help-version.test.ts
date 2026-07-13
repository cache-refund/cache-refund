/**
 * CLI-level tests for `--version` and `--help`: both must short-circuit
 * BEFORE the analysis pipeline, so they answer with zero transcripts and no
 * HOME dependence — that's what a fresh `npx cache-refund --version` on a
 * random machine looks like. Every HOME here is a fresh empty mkdtempSync
 * dir; these tests never write to HOME, so no settings-seeding helpers or
 * real-home guard are needed (see cli-standalone.test.ts for that
 * discipline where writes are in play).
 *
 * Skips (visibly) when dist/cli.js hasn't been built — same gate as
 * cli-standalone.test.ts.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "cli.js");
const PKG_VERSION = (JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")) as { version: string })
  .version;

const tempDirs: string[] = [];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "cachecash-cli-helpversion-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** Spawn the real CLI binary with HOME pointed at a synthetic, empty home. CI=1 forces the non-interactive path. */
function runCli(home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CI: "1" };
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const maybe = existsSync(CLI) ? describe : describe.skip;

maybe("--version and --help short-circuit before the pipeline", () => {
  it("--version exits 0 and prints the package.json version, nothing on stderr", () => {
    const home = freshHome();

    const r = runCli(home, ["--version"]);

    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(PKG_VERSION);
    expect(r.stderr).toBe("");
  });

  it("--help exits 0 and lists every subcommand, load-bearing flags, and the exit codes line", () => {
    const home = freshHome();

    const r = runCli(home, ["--help"]);

    expect(r.status).toBe(0);
    for (const subcommand of ["card", "enable", "revert", "verify", "recheck"]) {
      expect(r.stdout).toContain(subcommand);
    }
    for (const flag of ["--days", "--json", "--slack", "--all-time", "--price"]) {
      expect(r.stdout).toContain(flag);
    }
    expect(r.stdout).toContain("Exit codes");
  });

  it("--help in a completely empty HOME never touches the pipeline (routed before the transcripts gate)", () => {
    const home = freshHome();

    const r = runCli(home, ["--help"]);

    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("No transcripts found");
  });

  it("flag position doesn't matter: `card --version` still prints the version and exits 0", () => {
    const home = freshHome();

    const r = runCli(home, ["card", "--version"]);

    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(PKG_VERSION);
  });

  it("--version and --help together: --version wins (stdout is just the version)", () => {
    const home = freshHome();

    const r = runCli(home, ["--version", "--help"]);

    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(PKG_VERSION);
  });
});
