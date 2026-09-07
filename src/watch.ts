/**
 * One-shot TTL regression watchdog.
 *
 * The persisted state is deliberately content-free: it contains only the
 * observed TTL, whether a successful 1h observation has armed the watch, and
 * the time of the last state transition. Transcript paths, token counts, and
 * conversation content are never written.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "./pipeline.js";
import type { Regime } from "./types.js";

export const WATCH_STATE_RELATIVE_PATH = [".claude", "cache-refund", "watch.json"] as const;

export type ObservedTtl = Exclude<Regime, "none">;

export interface WatchState {
  version: 1;
  /** Once true, every 5m observation alarms until a 1h observation recovers. */
  armed: boolean;
  lastObserved: ObservedTtl;
  /** ISO time of the last state transition, not of every invocation. */
  checkedAt: string;
}

export type WatchStatus =
  | "no-writes"
  | "baseline-5m"
  | "armed"
  | "healthy"
  | "regression"
  | "still-regressed"
  | "recovered";

export interface WatchDecision {
  status: WatchStatus;
  /** Stable machine-readable signal for callers and schedulers. */
  alarm: boolean;
  /** 3 is reserved for a confirmed 1h -> 5m regression. */
  exitCode: 0 | 3;
  observed: Regime;
  nextState: WatchState | null;
  /** False for no writes and for observations that do not change state. */
  shouldPersist: boolean;
  message: string[];
}

export interface RunWatchOnceOptions {
  home?: string;
  /** Test/embedding seam; defaults to ~/.claude/cache-refund/watch.json. */
  statePath?: string;
  /** Test/embedding seam; defaults to a one-day run of the existing pipeline. */
  observeRegime?: (home: string) => Promise<Regime>;
  /** Test seam for deterministic state timestamps. */
  now?: () => Date;
}

export interface WatchRunResult extends WatchDecision {
  statePath: string;
  persisted: boolean;
}

export function watchStatePath(home: string = homedir()): string {
  return join(home, ...WATCH_STATE_RELATIVE_PATH);
}

/**
 * Observe the wall-clock recent TTL using the existing parser/analyzer.
 * `days: 1` is intentional: stale transcript history becomes `none` rather
 * than being mistaken for a current healthy or regressed observation.
 */
export async function observeCurrentRegime(home: string = homedir()): Promise<Regime> {
  const result = await run({ home, days: 1, allTime: false, jsonMode: true });
  return result.summary?.ttlRealityCheck.regime ?? "none";
}

/** Pure state machine used by the CLI and by fast unit tests. */
export function transitionWatchState(
  previous: WatchState | null,
  observed: Regime,
  checkedAt: string = new Date().toISOString(),
): WatchDecision {
  if (observed === "none") {
    return {
      status: "no-writes",
      alarm: false,
      exitCode: 0,
      observed,
      nextState: previous,
      shouldPersist: false,
      message: [
        "cache-refund watch: no fresh cache writes found; previous state was left unchanged.",
      ],
    };
  }

  if (previous === null) {
    const armed = observed === "1h";
    return {
      status: armed ? "armed" : "baseline-5m",
      alarm: false,
      exitCode: 0,
      observed,
      nextState: makeState(armed, observed, checkedAt),
      shouldPersist: true,
      message: armed
        ? [
            "cache-refund watch: armed ✓ — 1h cache writes are landing.",
            "Future 5m observations will raise a non-zero alarm.",
          ]
        : [
            "cache-refund watch: 5m cache writes observed; no working 1h baseline yet.",
            "Enable or restore 1h, start a new session, then run this again to arm the watch.",
          ],
    };
  }

  if (!previous.armed) {
    if (observed === "5m") {
      return {
        status: "baseline-5m",
        alarm: false,
        exitCode: 0,
        observed,
        nextState: previous,
        shouldPersist: false,
        message: [
          "cache-refund watch: unchanged — cache writes are still landing at 5m; watch is not armed.",
        ],
      };
    }

    return {
      status: "armed",
      alarm: false,
      exitCode: 0,
      observed,
      nextState: makeState(true, "1h", checkedAt),
      shouldPersist: true,
      message: [
        "cache-refund watch: 1h cache writes are now landing ✓ — watch armed.",
        "Future 5m observations will raise a non-zero alarm.",
      ],
    };
  }

  if (observed === "5m") {
    const firstAlarm = previous.lastObserved === "1h";
    return {
      status: firstAlarm ? "regression" : "still-regressed",
      alarm: true,
      exitCode: 3,
      observed,
      // Keep `armed: true`: recording the bad observation must never turn the
      // watchdog into a new, quiet 5m baseline.
      nextState: firstAlarm ? makeState(true, "5m", checkedAt) : previous,
      shouldPersist: firstAlarm,
      message: [
        firstAlarm
          ? "🚨 CACHE-REFUND WATCH: 1H CACHE REGRESSED TO 5M."
          : "🚨 CACHE-REFUND WATCH: CACHE IS STILL REGRESSED TO 5M.",
        "A previously confirmed 1h cache is now receiving 5m writes.",
        "Action: start a new Claude Code session and run `cache-refund verify`.",
        "If it persists, check your 1h setting/provider and anthropics/claude-code#49139.",
      ],
    };
  }

  if (previous.lastObserved === "5m") {
    return {
      status: "recovered",
      alarm: false,
      exitCode: 0,
      observed,
      nextState: makeState(true, "1h", checkedAt),
      shouldPersist: true,
      message: ["cache-refund watch: recovered ✓ — cache writes are back on 1h."],
    };
  }

  return {
    status: "healthy",
    alarm: false,
    exitCode: 0,
    observed,
    nextState: previous,
    shouldPersist: false,
    message: ["cache-refund watch: healthy ✓ — 1h cache writes are still landing."],
  };
}

export async function readWatchState(path: string): Promise<WatchState | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `cache-refund watch: refusing to replace malformed state at ${path}: ${errorMessage(error)}`,
    );
  }

  if (!isWatchState(value)) {
    throw new Error(`cache-refund watch: refusing to replace invalid state at ${path}`);
  }
  return value;
}

/** Atomic, owner-only state write. The final file mode is always 0600. */
export async function writeWatchState(path: string, state: WatchState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const contents = `${JSON.stringify(state, null, 2)}\n`;

  try {
    await writeFile(tempPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    // Be explicit even under an unusual process umask.
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // The temp file either never existed or was already renamed.
    }
    throw error;
  }
}

export async function runWatchOnce(options: RunWatchOnceOptions = {}): Promise<WatchRunResult> {
  const home = options.home ?? homedir();
  const statePath = options.statePath ?? watchStatePath(home);
  const observeRegime = options.observeRegime ?? observeCurrentRegime;
  const now = options.now ?? (() => new Date());

  // Read before scanning so corrupt state fails closed and is never replaced.
  const previous = await readWatchState(statePath);
  const observed = await observeRegime(home);
  const decision = transitionWatchState(previous, observed, now().toISOString());

  if (decision.shouldPersist && decision.nextState !== null) {
    await writeWatchState(statePath, decision.nextState);
  }

  return {
    ...decision,
    statePath,
    persisted: decision.shouldPersist && decision.nextState !== null,
  };
}

function makeState(armed: boolean, lastObserved: ObservedTtl, checkedAt: string): WatchState {
  return { version: 1, armed, lastObserved, checkedAt };
}

function isWatchState(value: unknown): value is WatchState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (state["version"] !== 1) return false;
  if (typeof state["armed"] !== "boolean") return false;
  if (state["lastObserved"] !== "1h" && state["lastObserved"] !== "5m") return false;
  if (typeof state["checkedAt"] !== "string" || Number.isNaN(Date.parse(state["checkedAt"]))) return false;
  // A successful 1h observation always arms the watch, so this combination
  // cannot be produced by this module and is treated as invalid state.
  return state["armed"] === true || state["lastObserved"] === "5m";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
