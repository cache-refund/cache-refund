import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = () => { const h = mkdtempSync(join(tmpdir(), "cache-refund-sub-cli-")); homes.push(h); return h; };
const settings = (h: string) => join(h, ".claude", "settings.json");
function run(h: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { HOME: h, USERPROFILE: h, PATH: process.env.PATH, CI: "1" }, encoding: "utf8", timeout: 15000,
  });
}
function seed(h: string) {
  const dir = join(h, ".claude", "projects", "private-project", "parent", "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "child.jsonl"), JSON.stringify({
    type: "assistant", timestamp: new Date().toISOString(), sessionId: "child", isSidechain: true,
    message: { id: "one", model: "claude-opus-4-8", usage: {
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 9961 },
      cache_read_input_tokens: 0,
    } },
  }) + "\n");
}

describe.skipIf(!existsSync(cli))("scoped CLI flow", () => {
  it("requires confirmation, then changes only the child setting", () => {
    const h = home();
    let r = run(h, ["enable", "--subagents"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("enable --subagents --yes");
    expect(existsSync(settings(h))).toBe(false);
    r = run(h, ["enable", "--subagents", "--yes"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(settings(h), "utf8"))).toEqual({ subagentPromptCacheTtl: "1h" });
    seed(h);
    r = run(h, ["verify", "--subagents"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("verified received 1h");
    expect(r.stdout).toContain("9,961 at 1h");
    r = run(h, ["revert", "--subagents", "--yes"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(settings(h), "utf8"))).toEqual({ subagentPromptCacheTtl: "5m" });
  });

  it("diagnoses child usage even when billing is ambiguous", () => {
    const h = home(); seed(h);
    const r = run(h, ["subagents"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("SUBAGENT CACHE");
    expect(r.stdout).toContain("9,961 at 1h");
    expect(r.stdout).not.toContain("private-project");
    expect(r.stdout).not.toContain("YOUR RECEIPT");
    expect(r.stdout).not.toContain("% less of your usage limit");
    expect(r.stdout.split("\n").every(line => line.length <= 80)).toBe(true);
  });

  it("--json returns additive evidence and never applies an action", () => {
    const h = home(); seed(h);
    const r = run(h, ["enable", "--subagents", "--json", "--yes"]);
    expect(r.status).toBe(0);
    const d = JSON.parse(r.stdout);
    expect(d.summaryVersion).toBe(1);
    expect(d.subagents.creation1h).toBe(9961);
    expect(d.ttlRealityCheck.regime).toBe("none");
    expect(existsSync(settings(h))).toBe(false);
  });

  it("rejects unsupported scope combinations rather than changing the main watch", () => {
    const h = home();
    const r = run(h, ["watch", "--subagents"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no scoped watch");
    expect(existsSync(join(h, ".claude", "cache-refund", "watch.json"))).toBe(false);
  });
});
