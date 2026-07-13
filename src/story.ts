import type { Summary } from "./types.js";

export interface UsagePatternStory {
  kind: "deep-sessions" | "long-running" | "many-sessions" | "bursty" | "tight-loop";
  text: string;
}

export function usagePatternStory(summary: Summary): UsagePatternStory {
  const turnsPerSession = summary.scope.sessions > 0 ? summary.scope.turns / summary.scope.sessions : 0;
  const highRecoverable = summary.recoverableRatio >= 0.25;
  const longRunning = turnsPerSession >= 40 && summary.wrapped.biggestSessionCreation >= 20_000_000;

  if (highRecoverable && turnsPerSession >= 80) {
    return {
      kind: "deep-sessions",
      text: "You work in deep, sustained sessions and often return after short breaks — a strong fit for the 1h cache.",
    };
  }

  if (highRecoverable && turnsPerSession < 25 && summary.scope.sessions >= 100) {
    return {
      kind: "many-sessions",
      text: "You spread work across many shorter sessions, with enough returns after breaks for the 1h cache to recover meaningful waste.",
    };
  }

  if (longRunning) {
    return {
      kind: "long-running",
      text: "High-volume, long-running sessions with frequent returns after 5–60 minutes — exactly where the 1h cache pays off.",
    };
  }
  if (highRecoverable) {
    return {
      kind: "bursty",
      text: "Bursty, cache-heavy work with many returns after short breaks — your 5m cache repeatedly expires between turns.",
    };
  }
  return {
    kind: "tight-loop",
    text: "Mostly tight interactive loops — the 5m cache already fits your workflow.",
  };
}
