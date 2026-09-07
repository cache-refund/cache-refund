import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discover } from "../src/discover.js";

const homes: string[] = [];

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("discover", () => {
  it("finds top-level and nested subagent transcripts without following symlink directories", () => {
    const home = mkdtempSync(join(tmpdir(), "cache-refund-discover-"));
    homes.push(home);
    const project = join(home, ".claude", "projects", "-tmp-project");
    const subagents = join(project, "session-1", "subagents");
    const outside = join(home, "outside");
    mkdirSync(subagents, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(project, "main.jsonl"), "\n");
    writeFileSync(join(subagents, "agent-1.jsonl"), "\n");
    writeFileSync(join(outside, "escaped.jsonl"), "\n");
    symlinkSync(outside, join(project, "linked-outside"));

    const result = discover(undefined, home);

    expect(result.files).toEqual([
      join(project, "main.jsonl"),
      join(subagents, "agent-1.jsonl"),
    ].sort());
    expect(result.files.map(result.projectOf)).toEqual(["-tmp-project", "-tmp-project"]);
  });

  it("accepts a direct project path whose transcripts exist only in nested directories", () => {
    const home = mkdtempSync(join(tmpdir(), "cache-refund-discover-"));
    homes.push(home);
    const project = join(home, "direct-project");
    const nested = join(project, "session", "subagents");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "agent.jsonl"), "\n");

    const result = discover(project, home);

    expect(result.roots).toEqual([project]);
    expect(result.files).toEqual([join(nested, "agent.jsonl")]);
  });
});
