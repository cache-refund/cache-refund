/**
 * TTY-only behavior, exercised through a REAL pseudo-terminal.
 *
 * Every other CLI test in this repo spawns `dist/cli.js` with ordinary
 * subprocess pipes — and a pipe can never make `process.stdout.isTTY` true
 * in the child, no matter how it's wired up. That leaves three code paths
 * permanently dead to pipe-based tests: the staggered TTY checkup (trust
 * line -> CHECKUP header -> gap bars -> wrapped insights -> ending), the
 * closing score-card that reprints as the run's final frame, and the share
 * CTA that follows it. A suite that never exercises any of that could watch
 * a second score box creep back above the fold, or the share prompt regrow
 * a frequency gate, and still stay green.
 *
 * test/helpers/pty_run.py closes that gap: it forks the real compiled binary
 * onto a genuine pty, so the child sees an actual terminal on fd 0/1/2,
 * auto-answers whatever interactive prompt shows up so the run never blocks
 * on a human, and hands back the full captured transcript plus exit status
 * as one JSON line.
 *
 * What these tests exist to catch:
 *   - a second box appearing anywhere above the closing card (the receipt
 *     ending draws none of its own — the closing card must be the only one
 *     in the whole interactive run);
 *   - the closing card losing its place after the ending, or CHECKUP
 *     re-opening once the card has already printed;
 *   - the share prompt regaining a once-per-machine gate (it must fire on
 *     every interactive checkup, not just the first per HOME);
 *   - either of its two opt-outs (`--no-share`, `CACHE_REFUND_NO_SHARE`)
 *     stopping short of full suppression, or taking the closing card down
 *     with it; or
 *   - the entrypoint guard rotting away — importing the compiled module
 *     must perform NO work (no transcript scan, no process.exit). That one
 *     gets a subprocess probe with a grace window rather than an in-worker
 *     import, because main() runs as an async side effect and an in-worker
 *     import resolves before that side effect can exit — a race the import
 *     usually wins (see the probe's own comment for the mechanism).
 *
 * Skip discipline mirrors the oracle-parity test. The pty block skips
 * (visibly, not silently) when `dist/cli.js` hasn't been built, on Windows,
 * or when python3 (or a working pty) isn't available. The entrypoint-guard
 * probe needs only the build — plain node, no pty, no python3 — so it gates
 * on that alone. A bare `npm test` on a fresh clone should never fail
 * confusingly for lacking a build step or a platform feature.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "dist", "cli.js");
const HARNESS = join(HERE, "helpers", "pty_run.py");
const FIXTURE = join(HERE, "fixtures", "regime-1h.jsonl");

// The CHEAP, ungated half of the entrypoint-guard check: importing the
// module graph resolves without throwing. It needs neither a build nor a
// pty, so it stays ungated — but it is also the WEAK half. main() runs as an
// ASYNC side effect, so even a regressed (unguarded) entrypoint only kicks
// the corpus scan off in the background; the import promise resolves
// immediately, this assertion runs, and the worker can exit before main()'s
// eventual process.exit() ever fires. So this catches only the FAST-EXIT
// variants of a guard regression — an import that throws outright, or a
// broken module graph — never the "main() quietly ran" case. The
// DETERMINISTIC execution check (that the guard actually suppresses main())
// is the subprocess probe below, which holds the process open past main()'s
// side effects with a grace window.
it("importing the CLI module resolves without throwing", async () => {
  const mod = await import("../src/cli.js");
  expect(mod).toBeTypeOf("object");
});

const REAL_ACCOUNT_HOME = (() => {
  try {
    return userInfo().homedir;
  } catch {
    return null;
  }
})();

const tempDirs: string[] = [];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "cache-refund-cli-pty-"));
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

/** True only when python3 ships a pty module that can actually open one here (sandboxes/containers sometimes can't). */
function ptyUsable(): boolean {
  if (process.platform === "win32") return false;
  try {
    execFileSync("python3", ["-c", "import pty, os\nm, s = pty.openpty()\nos.close(m)\nos.close(s)"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// Skips (visibly, as a reported "skip" — never a silent no-op) when dist
// isn't built, on Windows, or when python3/a working pty isn't available —
// the same soft-dependency discipline test/oracle-parity.test.ts uses for
// its own python3 dependency.
const maybe = existsSync(CLI) && ptyUsable() ? describe : describe.skip;

/**
 * Seed a HOME whose only transcript is the regime-1h fixture. That fixture
 * is a subscription-shaped corpus: branch detection resolves to
 * "subscription" with no interactive branch question, and the ending is the
 * receipt (no consent prompt) — so the only prompt a checkup run reaches at
 * all is the share CTA at the very end.
 */
function seedHome(): string {
  const home = freshHome();
  const projectDir = join(home, ".claude", "projects", "p");
  mkdirSync(projectDir, { recursive: true });
  copyFileSync(FIXTURE, join(projectDir, "s1.jsonl"));
  return home;
}

interface PtyResult {
  exit: number | null;
  timedOut: boolean;
  output: string;
}

/**
 * A child env with every ambient flag that could flip TTY-ness, branch
 * detection, or the share prompt scrubbed out, and HOME repointed at the
 * synthetic home. Callers layer their own settings on top: the pty runs add
 * TERM and leave CI unset (the interactive path); the guard probe sets CI=1.
 * CI=1 alone forces the non-interactive path — GitHub Actions always sets it,
 * which is exactly why it has to be scrubbed here.
 */
function scrubbedChildEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.CI;
  delete env.CACHE_REFUND_NO_SHARE;
  delete env.ENABLE_PROMPT_CACHING_1H;
  delete env.FORCE_PROMPT_CACHING_5M;
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  return env;
}

/** Run a checkup against `home` on a real pty and return the captured transcript, decoded and ANSI-stripped. */
function runCheckupOnPty(
  home: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): PtyResult & { stripped: string } {
  const env = scrubbedChildEnv(home);
  env.TERM = "xterm-256color"; // a real terminal type so the child's TTY path renders in full
  Object.assign(env, extraEnv); // suppression cases re-add theirs AFTER the scrub

  const r = spawnSync("python3", [HARNESS, "45", process.execPath, CLI, "--all-time", ...args], {
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) {
    throw new Error(`pty harness failed to spawn: ${r.error.message}\nstderr:\n${r.stderr ?? ""}`);
  }

  const lines = (r.stdout ?? "").split("\n").filter((l) => l.trim().length > 0);
  const lastLine = lines[lines.length - 1];
  if (lastLine === undefined) {
    throw new Error(`pty harness produced no output on its own stdout (exit ${r.status}).\nstderr:\n${r.stderr ?? ""}`);
  }

  let parsed: PtyResult;
  try {
    parsed = JSON.parse(lastLine) as PtyResult;
  } catch (err) {
    throw new Error(
      `pty harness stdout was not valid JSON (${String(err)}).\nlast line: ${lastLine}\nstderr:\n${r.stderr ?? ""}`,
    );
  }

  const stripped = parsed.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n/g, "\n");
  return { ...parsed, stripped };
}

maybe("interactive checkup on a real pty (outcome card + final menu)", () => {
  it("the outcome card appears exactly once immediately before the final menu", () => {
    const home = seedHome();
    const r = runCheckupOnPty(home, []);

    expect(r.timedOut).toBe(false);
    expect(r.exit).toBe(0);

    const { stripped } = r;

    // Box census: the receipt ending, unlike CERTIFIED OPTIMAL's, draws no
    // box of its own, so on this fixture one box total is the law — the
    // closing card is the ONLY box in the whole interactive run.
    expect((stripped.match(/╭/g) ?? []).length).toBe(1);
    expect((stripped.match(/╰/g) ?? []).length).toBe(1);

    const checkupIdx = stripped.indexOf("CHECKUP");
    const receiptIdx = stripped.indexOf("YOUR RECEIPT");
    const boxIdx = stripped.indexOf("╭");
    const menuIdx = stripped.indexOf("Ready to share");
    expect(checkupIdx).toBeGreaterThanOrEqual(0);
    expect(receiptIdx).toBeGreaterThanOrEqual(0);
    expect(boxIdx).toBeGreaterThanOrEqual(0);
    expect(menuIdx).toBeGreaterThanOrEqual(0);

    const reportIdx = stripped.indexOf("Detailed report saved to");
    expect(reportIdx).toBeGreaterThanOrEqual(0);

    // Ordering chain: CHECKUP, receipt prose, saved report, one outcome card,
    // then immediately the raw-key action menu.
    expect(checkupIdx).toBeLessThan(receiptIdx);
    expect(receiptIdx).toBeLessThan(reportIdx);
    expect(reportIdx).toBeLessThan(boxIdx);
    expect(boxIdx).toBeLessThan(menuIdx);
    expect(stripped.slice(boxIdx, menuIdx)).not.toContain("YOUR RECEIPT");

    // The box itself is the receipt card, not some other box.
    expect(stripped).toContain("1H CACHE USES");
    expect(stripped).toContain("LESS OF YOUR LIMIT");

    // Nothing re-opens the CHECKUP section once the closing card has printed.
    expect(stripped.slice(boxIdx).includes("CHECKUP")).toBe(false);

    expect((stripped.match(/Ready to share/g) ?? []).length).toBe(1);
  });

  it("the final menu appears on every interactive checkup, not once per machine", () => {
    const home = seedHome();
    const first = runCheckupOnPty(home, []);
    const second = runCheckupOnPty(home, []);

    // Guards the removal of the old once-per-machine gate: state left
    // behind by the first run must not silence the second. (.trim(): the
    // product string ends with a trailing space that pty line-discipline
    // may or may not preserve at a line boundary.)
    expect(first.stripped).toContain("Ready to share — press Enter to copy the card image");
    expect(second.stripped).toContain("Ready to share — press Enter to copy the card image");
  });

  it("--no-share suppresses the share prompt entirely (no prompt, no hint)", () => {
    const home = seedHome();
    const r = runCheckupOnPty(home, ["--no-share"]);

    expect(r.exit).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stripped).not.toContain("Ready to share");
    // Suppression must not eat the closing card.
    expect((r.stripped.match(/╭/g) ?? []).length).toBe(1);
  });

  it("CACHE_REFUND_NO_SHARE=1 suppresses it the same way", () => {
    const home = seedHome();
    const r = runCheckupOnPty(home, [], { CACHE_REFUND_NO_SHARE: "1" });

    expect(r.exit).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stripped).not.toContain("Ready to share");
    expect((r.stripped.match(/╭/g) ?? []).length).toBe(1);
  });
});

// The DETERMINISTIC counterpart to the ungated import test at the top: it
// proves the entrypoint guard actually suppresses main() on import, with no
// race to lose. Gated on the BUILD ALONE (plain node — no pty, no python3),
// so it runs anywhere `dist/cli.js` exists.
const maybeBuilt = existsSync(CLI) ? describe : describe.skip;

maybeBuilt("entrypoint guard on the compiled module", () => {
  it("importing the compiled CLI performs no work (entrypoint guard holds)", () => {
    const home = freshHome(); // EMPTY on purpose: an unguarded main() in an
    // empty HOME reaches its "No transcripts found" process.exit(1) in
    // milliseconds — well inside the grace window below — so the child dying
    // with exit 1 (instead of the sentinel's 42) is a deterministic
    // regression signal, not a race.

    // The child imports the real compiled module on a live event loop, prints
    // a sentinel, then holds the process open for a 400ms grace window before
    // exiting 42. A regressed (unguarded) entrypoint starts main() as an
    // import side effect; in an empty HOME that hits the no-transcripts
    // exit(1) DURING the window and preempts the sentinel exit(42) — so exit
    // code 42 plus clean stderr proves the import performed no work. Note
    // `node -e` has no argv[1], which is also why the guard must treat a
    // missing argv[1] as "not a direct run".
    const script = [
      `await import(${JSON.stringify(pathToFileURL(CLI).href)});`,
      `process.stdout.write("IMPORT_PERFORMED_NO_WORK\\n");`,
      `await new Promise((r) => setTimeout(r, 400));`,
      `process.exit(42);`,
    ].join("\n");

    const env = scrubbedChildEnv(home);
    env.CI = "1"; // belt-and-braces: even a regressed run must take the non-interactive path

    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env,
      encoding: "utf8",
    });

    expect(r.status).toBe(42);
    expect(r.stdout).toContain("IMPORT_PERFORMED_NO_WORK");
    expect(r.stderr ?? "").not.toContain("No transcripts found");
  });
});
