import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readWatchState,
  runWatchOnce,
  transitionWatchState,
  watchStatePath,
  type WatchState,
} from "../src/watch.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("transitionWatchState", () => {
  const t1 = "2026-08-20T00:00:00.000Z";
  const t2 = "2026-08-20T01:00:00.000Z";
  const t3 = "2026-08-20T02:00:00.000Z";

  it("arms on first 1h observation and reports an unchanged 1h as healthy", () => {
    const armed = transitionWatchState(null, "1h", t1);
    expect(armed).toMatchObject({ status: "armed", alarm: false, exitCode: 0, shouldPersist: true });

    const healthy = transitionWatchState(armed.nextState, "1h", t2);
    expect(healthy).toMatchObject({
      status: "healthy",
      alarm: false,
      exitCode: 0,
      shouldPersist: false,
      nextState: armed.nextState,
    });
    expect(healthy.message.join("\n")).toContain("healthy");
  });

  it("keeps alarming after 1h -> 5m until 1h recovers", () => {
    const armed = transitionWatchState(null, "1h", t1);
    const regression = transitionWatchState(armed.nextState, "5m", t2);

    expect(regression).toMatchObject({
      status: "regression",
      alarm: true,
      exitCode: 3,
      shouldPersist: true,
      nextState: { armed: true, lastObserved: "5m" },
    });
    expect(regression.message.join("\n")).toContain("REGRESSED TO 5M");
    expect(regression.message.join("\n")).toContain("cache-refund verify");

    const repeated = transitionWatchState(regression.nextState, "5m", t3);
    expect(repeated).toMatchObject({
      status: "still-regressed",
      alarm: true,
      exitCode: 3,
      shouldPersist: false,
    });

    const recovered = transitionWatchState(regression.nextState, "1h", t3);
    expect(recovered).toMatchObject({
      status: "recovered",
      alarm: false,
      exitCode: 0,
      shouldPersist: true,
      nextState: { armed: true, lastObserved: "1h" },
    });
  });

  it("ignores a no-write observation without changing state", () => {
    const previous: WatchState = {
      version: 1,
      armed: true,
      lastObserved: "1h",
      checkedAt: t1,
    };
    const decision = transitionWatchState(previous, "none", t2);
    expect(decision).toMatchObject({
      status: "no-writes",
      alarm: false,
      shouldPersist: false,
      nextState: previous,
    });
  });

  it("keeps a first-ever 5m baseline quiet but arms when 1h appears", () => {
    const baseline = transitionWatchState(null, "5m", t1);
    expect(baseline).toMatchObject({ status: "baseline-5m", alarm: false, exitCode: 0 });

    const armed = transitionWatchState(baseline.nextState, "1h", t2);
    expect(armed).toMatchObject({
      status: "armed",
      alarm: false,
      nextState: { armed: true, lastObserved: "1h" },
    });
  });
});

describe("runWatchOnce state I/O", () => {
  it("writes only content-free state at mode 0600", async () => {
    const home = await tempHome();
    const result = await runWatchOnce({
      home,
      observeRegime: async () => "1h",
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(result).toMatchObject({ status: "armed", persisted: true, alarm: false });
    expect(result.statePath).toBe(watchStatePath(home));
    expect((await stat(result.statePath)).mode & 0o777).toBe(0o600);

    const raw = await readFile(result.statePath, "utf8");
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      armed: true,
      lastObserved: "1h",
      checkedAt: "2026-08-20T00:00:00.000Z",
    });
    expect(raw).not.toMatch(/token|transcript|project|content|session/i);
  });

  it("does not overwrite the state file when there are no fresh writes", async () => {
    const home = await tempHome();
    const first = await runWatchOnce({
      home,
      observeRegime: async () => "1h",
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const before = await readFile(first.statePath, "utf8");

    const noWrites = await runWatchOnce({
      home,
      observeRegime: async () => "none",
      now: () => new Date("2026-08-21T00:00:00.000Z"),
    });

    expect(noWrites).toMatchObject({ status: "no-writes", persisted: false });
    expect(await readFile(first.statePath, "utf8")).toBe(before);
  });

  it("fails closed instead of replacing malformed state", async () => {
    const home = await tempHome();
    const path = watchStatePath(home);
    await writeFile(path, "not-json\n", { mode: 0o600 });

    await expect(
      runWatchOnce({ home, observeRegime: async () => "1h" }),
    ).rejects.toThrow("refusing to replace malformed state");
    expect(await readFile(path, "utf8")).toBe("not-json\n");
    await expect(readWatchState(path)).rejects.toThrow("refusing to replace malformed state");
  });
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "cache-refund-watch-"));
  dirs.push(home);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(home, ".claude", "cache-refund"), { recursive: true }));
  return home;
}
