/**
 * Share-CTA tests (v1.0.1):
 *   - share.ts platform plumbing: intent URLs, per-platform commands, and
 *     the no-clipboard-tool fallback path (injected fake spawn — nothing
 *     here touches the real system).
 *   - actions.ts frequency guard under a temp HOME: once-per-machine
 *     semantics, share-only file is not a recheck baseline, and a
 *     subsequent enable's baseline write PRESERVES the shown marker.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bskyIntentUrl,
  clipboardCommandFor,
  copyToClipboard,
  openCommandFor,
  SHARE_PROMPT_LINE,
  xIntentUrl,
  type SpawnLike,
} from "../src/share.js";
import { applyEnable, recordSharePromptShown, runRecheck, sharePromptShown } from "../src/actions.js";
import { fixtureEndingAEnable } from "./fixtures/summaries.js";

describe("share intent URLs", () => {
  it("x.com intent URL-encodes the text", () => {
    const url = xIntentUrl("hello #cachecash & more");
    expect(url.startsWith("https://x.com/intent/post?text=")).toBe(true);
    expect(url).toContain("%23cachecash");
    expect(url).toContain("%26");
    expect(url).not.toContain(" ");
  });
  it("bsky compose intent URL-encodes the text", () => {
    const url = bskyIntentUrl("saved $1,234.56 — details");
    expect(url.startsWith("https://bsky.app/intent/compose?text=")).toBe(true);
    expect(url).not.toContain(" ");
  });
  it("prompt line offers x/b/c and Enter-to-skip", () => {
    expect(SHARE_PROMPT_LINE).toContain("[x]");
    expect(SHARE_PROMPT_LINE).toContain("[b]");
    expect(SHARE_PROMPT_LINE).toContain("[c]");
    expect(SHARE_PROMPT_LINE.toLowerCase()).toContain("skip");
  });
});

describe("per-platform commands", () => {
  it("browser-open commands", () => {
    expect(openCommandFor("https://u", "darwin")).toEqual({ cmd: "open", args: ["https://u"] });
    expect(openCommandFor("https://u", "linux")).toEqual({ cmd: "xdg-open", args: ["https://u"] });
    expect(openCommandFor("https://u", "win32")).toEqual({ cmd: "cmd", args: ["/c", "start", "", "https://u"] });
  });
  it("clipboard commands", () => {
    expect(clipboardCommandFor("darwin").cmd).toBe("pbcopy");
    expect(clipboardCommandFor("win32").cmd).toBe("clip");
    expect(clipboardCommandFor("linux")).toEqual({ cmd: "xclip", args: ["-selection", "clipboard"] });
  });
});

describe("clipboard fallback path (fake spawn, no real system access)", () => {
  it("resolves false when the clipboard tool is missing (ENOENT)", async () => {
    const failingSpawn: SpawnLike = () => ({
      on(event: "error" | "close", cb: (arg?: unknown) => void) {
        if (event === "error") setTimeout(() => cb(new Error("ENOENT")), 0);
      },
      stdin: { write() {}, end() {} },
    });
    const ok = await copyToClipboard("text", "linux", failingSpawn);
    expect(ok).toBe(false);
  });
  it("resolves true and pipes the text on a clean exit", async () => {
    let piped = "";
    const okSpawn: SpawnLike = () => ({
      on(event: "error" | "close", cb: (arg?: unknown) => void) {
        if (event === "close") setTimeout(() => cb(0), 0);
      },
      stdin: {
        write(s: string) {
          piped += s;
        },
        end() {},
      },
    });
    const ok = await copyToClipboard("the md block", "darwin", okSpawn);
    expect(ok).toBe(true);
    expect(piped).toBe("the md block");
  });
});

describe("share-prompt frequency guard (temp HOME — never the real one)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cache-cash-share-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("unshown by default; recordSharePromptShown flips it exactly once per machine", () => {
    expect(sharePromptShown(home)).toBe(false);
    recordSharePromptShown(home);
    expect(sharePromptShown(home)).toBe(true);
    const raw = JSON.parse(readFileSync(join(home, ".claude", "cache-cash.json"), "utf8"));
    expect(typeof raw.sharePrompt.shownAt).toBe("string");
  });

  it("a share-only marker file is NOT a recheck baseline", async () => {
    recordSharePromptShown(home);
    const res = await runRecheck({ home });
    expect(res.message.join("\n")).toContain("no baseline found");
  });

  it("a later enable's baseline write PRESERVES the shown marker (no re-arm)", () => {
    recordSharePromptShown(home);
    const res = applyEnable({ home, summary: fixtureEndingAEnable });
    expect(res.applied).toBe(true);
    expect(sharePromptShown(home)).toBe(true);
    const raw = JSON.parse(readFileSync(join(home, ".claude", "cache-cash.json"), "utf8"));
    expect(typeof raw.sharePrompt.shownAt).toBe("string");
    expect(typeof raw.enabled_at).toBe("string"); // real baseline fields landed too
  });

  it("recording after an existing baseline preserves the baseline fields", () => {
    const res = applyEnable({ home, summary: fixtureEndingAEnable });
    expect(res.applied).toBe(true);
    recordSharePromptShown(home);
    const raw = JSON.parse(readFileSync(join(home, ".claude", "cache-cash.json"), "utf8"));
    expect(typeof raw.enabled_at).toBe("string");
    expect(typeof raw.sharePrompt.shownAt).toBe("string");
    expect(raw.efficiencyScore).toBe(fixtureEndingAEnable.efficiencyScore);
  });
});
