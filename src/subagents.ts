/** Child-only observations. No API-price-to-subscription-quota conversion. */
import { analyze } from "./analyze.js";
import { wrapLine } from "./format.js";
import type { SubagentSummary, SubagentTtl, TurnEvent } from "./types.js";

export function observedSubagentTtl(c5: number, c1: number, unknown: number): SubagentTtl {
  if (unknown > 0) return "unknown";
  if (c5 > 0 && c1 > 0) return "mixed";
  if (c1 > 0) return "1h";
  if (c5 > 0) return "5m";
  return "none";
}

export function summarizeSubagents(
  events: TurnEvent[], windowDays: number, lastTs: number | null,
): SubagentSummary {
  const children = events.filter(e => e.isSidechain);
  const result: SubagentSummary = {
    sessions: new Set(children.map(e => e.sessionKey)).size,
    turns: children.length, creation5m: 0, creation1h: 0, creationUnknown: 0,
    readTokens: 0, pauseWriteTokens: 0,
    recent: { windowDays, ttl: "none", creation5m: 0, creation1h: 0, creationUnknown: 0 },
  };
  const cutoff = lastTs === null ? Infinity : lastTs - windowDays * 86400;
  for (const e of children) {
    result.readTokens += e.read;
    for (const bucket of e.ts >= cutoff ? [result, result.recent] : [result]) {
      if (e.cacheTtlInferred) bucket.creationUnknown += e.c5 + e.c1;
      else { bucket.creation5m += e.c5; bucket.creation1h += e.c1; }
    }
  }
  result.recent.ttl = observedSubagentTtl(result.recent.creation5m, result.recent.creation1h, result.recent.creationUnknown);
  for (const a of analyze(children).annotated) {
    if (a.gap === "recoverable" && !a.modelSwitch && !a.ev.compactBoundaryBefore && !a.ev.cacheTtlInferred) {
      result.pauseWriteTokens += a.ev.c5;
    }
  }
  return result;
}

const count = (n: number) => n.toLocaleString("en-US");

export function renderSubagents(s: SubagentSummary): string[] {
  const lines = ["SUBAGENT CACHE", "",
    `${count(s.sessions)} subagent sessions, ${count(s.turns)} turns in the analyzed window.`,
    `Cache writes: ${count(s.creation5m)} tokens at 5m; ${count(s.creation1h)} at 1h.`,
    `Cache reads: ${count(s.readTokens)} tokens.`,
    `Recent TTL (last ${s.recent.windowDays}d of analyzed activity): ${s.recent.ttl}.`,
  ];
  if (s.creationUnknown > 0) lines.push(`${count(s.creationUnknown)} write tokens have no explicit TTL breakdown; their TTL is unknown.`);
  if (s.turns === 0) lines.push("No subagent usage found in this window.");
  else if (s.pauseWriteTokens > 0) {
    lines.push(`${count(s.pauseWriteTokens)} 5m write tokens followed 5-60m pauses within a subagent session.`,
      "A 1h TTL is worth testing for these pauses; new context can also cause writes.",
      "To test it: npx cache-refund enable --subagents");
  } else {
    lines.push("No explicit 5m writes after eligible 5-60m pauses were found; no longer-TTL recommendation.");
  }
  lines.push("", "Subagent TTL is configurable on API billing and included subscription usage (Claude Code 2.1.242+).",
    "Longer TTL does not make a new subagent inherit its parent's cache.",
    "Subscription quota savings are not measured by this report.",
    "Check delivery: npx cache-refund verify --subagents");
  return lines.flatMap(line => wrapLine(line, 78));
}
