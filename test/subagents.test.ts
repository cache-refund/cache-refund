import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../src/analyze.js";
import { leakRows } from "../src/costmodel.js";
import { parseJsonlString } from "../src/parse.js";
import { applySubagentTtl, runSubagentVerify } from "../src/actions.js";
import { summarizeSubagents, renderSubagents } from "../src/subagents.js";
import type { TurnEvent } from "../src/types.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const freshHome = () => {
  const home = mkdtempSync(join(tmpdir(), "cache-refund-subagents-"));
  homes.push(home);
  mkdirSync(join(home, ".claude"));
  return home;
};
const settingsPath = (home: string) => join(home, ".claude", "settings.json");
const ev = (overrides: Partial<TurnEvent> = {}): TurnEvent => ({
  ts: 1_000_000, model: "claude-opus-4-8", sessionKey: "child", isSidechain: true,
  c5: 0, c1: 0, read: 0, compactBoundaryBefore: false, project: "private-project", ...overrides,
});
function seedTurns(home: string, turns: TurnEvent[]) {
  const dir = join(home, ".claude", "projects", "test", "session", "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "child.jsonl"), turns.map((e, i) => JSON.stringify({
    type: "assistant", timestamp: new Date(e.ts * 1000).toISOString(), sessionId: e.sessionKey,
    isSidechain: e.isSidechain, message: { id: `turn-${i}`, model: e.model, usage: {
      cache_creation: { ephemeral_5m_input_tokens: e.c5, ephemeral_1h_input_tokens: e.c1 },
      cache_read_input_tokens: e.read,
    } },
  })).join("\n"));
}

describe("subagent TTL evidence", () => {
  it("reports child 1h writes separately from parent 5m writes", () => {
    const d = summarizeSubagents([ev({ c1: 9961 }), ev({ isSidechain: false, c5: 50000 })], 7, 1_000_000);
    expect(d.turns).toBe(1);
    expect(d.creation1h).toBe(9961);
    expect(d.creation5m).toBe(0);
    expect(d.recent.ttl).toBe("1h");
    expect(renderSubagents(d).join("\n")).toContain("subscription");
    expect(renderSubagents(d).join("\n")).not.toContain("private-project");
  });

  it("preserves mixed TTL evidence even if one bucket dominates", () => {
    const d = summarizeSubagents([ev({ c1: 100000 }), ev({ c5: 1 })], 7, 1_000_000);
    expect(d.recent.ttl).toBe("mixed");
    expect(renderSubagents(d).join("\n")).toContain("mixed");
  });

  it("does not turn legacy flat creation counts into confirmed 5m evidence", () => {
    const events = parseJsonlString(JSON.stringify({ timestamp: "2026-09-01T00:00:00Z", isSidechain: true,
      message: { id: "legacy", model: "claude-opus-4-8", usage: { cache_creation_input_tokens: 1000 } } }), "legacy");
    const d = summarizeSubagents(events, 7, events[0].ts);
    expect(d.creationUnknown).toBe(1000);
    expect(d.creation5m).toBe(0);
    expect(d.recent.ttl).toBe("unknown");
  });

  it("does not double-count a partial TTL breakdown's one-hour tokens", () => {
    const events = parseJsonlString(JSON.stringify({ timestamp: "2026-09-01T00:00:00Z", isSidechain: true,
      message: { id: "partial", model: "claude-opus-4-8", usage: {
        cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000 },
      } } }), "partial");
    expect(summarizeSubagents(events, 7, events[0].ts).creationUnknown).toBe(1000);
  });

  it("only suggests testing longer TTL for pauses within the same child, without reset boundaries", () => {
    const start = ev({ c5: 1000 });
    const pause = ev({ ts: start.ts + 600, c5: 1000 });
    const d = summarizeSubagents([start, pause], 7, pause.ts);
    expect(d.pauseWriteTokens).toBe(1000);
    expect(renderSubagents(d).join("\n")).toContain("enable --subagents");
    for (const changed of [ev({ ...pause, sessionKey: "other" }), ev({ ...pause, compactBoundaryBefore: true }),
      ev({ ...pause, model: "claude-sonnet-4-6" })]) {
      expect(summarizeSubagents([start, changed], 7, changed.ts).pauseWriteTokens).toBe(0);
    }
  });

  it("never prices 1h child writes as 5m overhead", () => {
    const rows = leakRows(analyze([ev({ c1: 1_000_000 })]).annotated, 10);
    expect(rows.find(r => r.cause === "subagent-5m")?.tokens).toBe(0);
    expect(rows.find(r => r.cause === "subagent-1h")?.dollars).toBeCloseTo(10);
  });
});

describe("scoped settings and verification", () => {
  it("can opt a subscriber into 1h and return children to 5m while preserving main settings", () => {
    const home = freshHome();
    const original = { promptCacheTtl: "1h", model: "opus", env: { ENABLE_PROMPT_CACHING_1H: "1", KEEP: "yes" } };
    writeFileSync(settingsPath(home), JSON.stringify(original));
    expect(applySubagentTtl({ home, env: {} }, "1h").applied).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath(home), "utf8"))).toEqual({ ...original, subagentPromptCacheTtl: "1h" });
    expect(applySubagentTtl({ home, env: {} }, "5m").applied).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath(home), "utf8"))).toEqual({ ...original, subagentPromptCacheTtl: "5m" });
  });

  it.each([
    [{ env: { FORCE_PROMPT_CACHING_5M: "1" } }, {}],
    [{}, { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m" }],
    [{ env: { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m" } }, {}],
  ])("refuses a conflicting higher-priority control", (doc, env) => {
    const home = freshHome();
    writeFileSync(settingsPath(home), JSON.stringify(doc));
    const before = readFileSync(settingsPath(home), "utf8");
    const r = applySubagentTtl({ home, env }, "1h");
    expect(r.applied).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(readFileSync(settingsPath(home), "utf8")).toBe(before);
  });

  it("refuses malformed settings without replacing them", () => {
    const home = freshHome();
    writeFileSync(settingsPath(home), "broken JSON");
    expect(applySubagentTtl({ home, env: {} }, "1h").applied).toBe(false);
    expect(readFileSync(settingsPath(home), "utf8")).toBe("broken JSON");
  });

  it("verifies only child writes after the scoped change, excluding older and parent evidence", async () => {
    const home = freshHome();
    const oldTs = Date.now() / 1000 - 60;
    applySubagentTtl({ home, env: {} }, "1h");
    const now = Date.now() / 1000 + 0.01;
    seedTurns(home, [ev({ ts: oldTs, c1: 1000 }), ev({ ts: now, isSidechain: false, c1: 100000 }),
      ev({ ts: now, c5: 1000 })]);
    const r = await runSubagentVerify({ home, env: {} });
    expect(r.message.join("\n")).toContain("received 5m");
    expect(r.message.join("\n")).not.toContain("verified");
  });

  it("reports mixed child writes without certifying success", async () => {
    const home = freshHome();
    seedTurns(home, [ev({ ts: Date.now() / 1000, c1: 10000, c5: 1 })]);
    const r = await runSubagentVerify({ home, env: {} });
    expect(r.message.join("\n")).toContain("mixed");
    expect(r.message.join("\n")).not.toContain("verified");
  });

  it("does not claim verification without new child writes", async () => {
    const home = freshHome();
    applySubagentTtl({ home, env: {} }, "1h");
    seedTurns(home, [ev({ ts: Date.now() / 1000, isSidechain: false, c1: 10000 })]);
    expect((await runSubagentVerify({ home, env: {} })).message.join("\n")).toContain("no fresh subagent cache writes");
  });
});
