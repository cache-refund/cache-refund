/**
 * Share-CTA tests (v1.0.1, extended v1.0.2):
 *   - share.ts platform plumbing: intent URLs, per-platform commands, the
 *     no-clipboard-tool fallback path (injected fake spawn — nothing here
 *     touches the real system), the CACHE_REFUND_NO_SHARE suppression
 *     check, and the image-clipboard command construction + fallback chain.
 *
 * The once-per-machine share-prompt gate (actions.ts's former
 * sharePromptShown/recordSharePromptShown) is gone in v1.0.2 — the prompt
 * now has no frequency guard at all, only the standing --no-share /
 * CACHE_REFUND_NO_SHARE opt-out tested below. Actual end-to-end ordering
 * (prompt appears every run, --no-share silences it) is TTY-only behavior
 * that isn't reachable through spawnSync (no pipe is a TTY) — verified via
 * a manual pty smoke run instead of a vitest test; see the gate report.
 */

import { describe, expect, it } from "vitest";
import {
  bskyIntentUrl,
  clipboardCommandFor,
  copyImageToClipboard,
  copyToClipboard,
  imageClipboardCommandsFor,
  noShareEnvSet,
  openCommandFor,
  runLinkedInShare,
  runShareAccept,
  xIntentUrl,
  type ShareAcceptDeps,
  type SpawnLike,
} from "../src/share.js";

describe("share intent URLs", () => {
  it("x.com intent URL-encodes the text", () => {
    const url = xIntentUrl("hello #cacherefund & more");
    expect(url.startsWith("https://x.com/intent/post?text=")).toBe(true);
    expect(url).toContain("%23cacherefund");
    expect(url).toContain("%26");
    expect(url).not.toContain(" ");
  });
  it("bsky compose intent URL-encodes the text", () => {
    const url = bskyIntentUrl("saved $1,234.56 — details");
    expect(url.startsWith("https://bsky.app/intent/compose?text=")).toBe(true);
    expect(url).not.toContain(" ");
  });
});

describe("LinkedIn share workflow", () => {
  it("copies post text, reveals the card, explains the blank composer, then opens LinkedIn", async () => {
    const calls: string[] = [];
    await runLinkedInShare("prepared post", "/tmp/card.png", {
      copyToClipboard: async (text) => {
        calls.push(`copy:${text}`);
        return true;
      },
      revealFile: (path) => calls.push(`reveal:${path}`),
      openExternal: async (url) => {
        calls.push(`open:${url}`);
        return true;
      },
      write: (text) => calls.push(`write:${text}`),
    });
    expect(calls).toEqual([
      "copy:prepared post",
      "reveal:/tmp/card.png",
      "write:LinkedIn does not support prefilled post text — text copied to clipboard. Paste it, then attach the card image:\n/tmp/card.png\n",
      "open:https://www.linkedin.com/feed/?shareActive=true",
    ]);
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
        write(s: string | Buffer) {
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

describe("--no-share suppression: CACHE_REFUND_NO_SHARE env truthiness (v1.0.2)", () => {
  it("unset or falsy -> not suppressed", () => {
    expect(noShareEnvSet({})).toBe(false);
    expect(noShareEnvSet({ CACHE_REFUND_NO_SHARE: "0" })).toBe(false);
    expect(noShareEnvSet({ CACHE_REFUND_NO_SHARE: "" })).toBe(false);
    expect(noShareEnvSet({ CACHE_REFUND_NO_SHARE: "false" })).toBe(false);
  });
  it('"1" or "true" (case-insensitive) -> suppressed', () => {
    expect(noShareEnvSet({ CACHE_REFUND_NO_SHARE: "1" })).toBe(true);
    expect(noShareEnvSet({ CACHE_REFUND_NO_SHARE: "true" })).toBe(true);
    expect(noShareEnvSet({ CACHE_REFUND_NO_SHARE: "TRUE" })).toBe(true);
  });
});

describe("image clipboard (v1.0.2): command construction + fallback chain", () => {
  it("darwin: a single osascript call reading the PNG via POSIX file, as «class PNGf»", () => {
    const cmds = imageClipboardCommandsFor("/Users/x/Downloads/cache-refund-card.png", "darwin");
    expect(cmds).toHaveLength(1);
    expect(cmds[0].cmd).toBe("osascript");
    expect(cmds[0].args[0]).toBe("-e");
    expect(cmds[0].args[1]).toContain('POSIX file "/Users/x/Downloads/cache-refund-card.png"');
    expect(cmds[0].args[1]).toContain("«class PNGf»");
  });
  it("darwin: escapes embedded double quotes in the path for the AppleScript literal", () => {
    const cmds = imageClipboardCommandsFor('/tmp/weird "path"/card.png', "darwin");
    expect(cmds[0].args[1]).toContain('\\"path\\"');
  });
  it("linux: tries wl-copy (stdin-piped) before xclip (-i <path>)", () => {
    const cmds = imageClipboardCommandsFor("/tmp/card.png", "linux");
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toEqual({ cmd: "wl-copy", args: ["-t", "image/png"], pipeFile: true });
    expect(cmds[1]).toEqual({ cmd: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-i", "/tmp/card.png"] });
  });
  it("win32 (and any other unlisted platform): no image-clipboard commands", () => {
    expect(imageClipboardCommandsFor("/tmp/card.png", "win32")).toEqual([]);
  });

  function fakeSpawn(script: Record<string, "ok" | "enoent" | "fail">, calls: string[]): SpawnLike {
    return (cmd: string) => {
      calls.push(cmd);
      const outcome = script[cmd] ?? "enoent";
      return {
        on(event: "error" | "close", cb: (arg?: unknown) => void) {
          if (outcome === "enoent" && event === "error") setTimeout(() => cb(new Error("ENOENT")), 0);
          if (outcome === "ok" && event === "close") setTimeout(() => cb(0), 0);
          if (outcome === "fail" && event === "close") setTimeout(() => cb(1), 0);
        },
        stdin: { write() {}, end() {} },
      };
    };
  }

  it("darwin: resolves true on a clean osascript exit", async () => {
    const calls: string[] = [];
    const ok = await copyImageToClipboard(
      "/tmp/card.png",
      "darwin",
      fakeSpawn({ osascript: "ok" }, calls),
      () => Buffer.from("png"),
    );
    expect(ok).toBe(true);
    expect(calls).toEqual(["osascript"]);
  });

  it("linux: wl-copy missing (ENOENT) falls back to xclip, which succeeds", async () => {
    const calls: string[] = [];
    const ok = await copyImageToClipboard(
      "/tmp/card.png",
      "linux",
      fakeSpawn({ "wl-copy": "enoent", xclip: "ok" }, calls),
      () => Buffer.from("png-bytes"),
    );
    expect(ok).toBe(true);
    expect(calls).toEqual(["wl-copy", "xclip"]); // tried in order, fell through once
  });

  it("linux: both wl-copy and xclip fail -> resolves false, never throws", async () => {
    const calls: string[] = [];
    const ok = await copyImageToClipboard(
      "/tmp/card.png",
      "linux",
      fakeSpawn({ "wl-copy": "fail", xclip: "fail" }, calls),
      () => Buffer.from("png-bytes"),
    );
    expect(ok).toBe(false);
    expect(calls).toEqual(["wl-copy", "xclip"]);
  });

  it("win32: resolves false immediately, spawns nothing", async () => {
    const calls: string[] = [];
    const ok = await copyImageToClipboard("/tmp/card.png", "win32", fakeSpawn({}, calls), () => Buffer.from("x"));
    expect(ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("wl-copy pipes the PNG bytes (not the path) on stdin", async () => {
    let piped: Buffer | undefined;
    const pipingSpawn: SpawnLike = () => ({
      on(event: "error" | "close", cb: (arg?: unknown) => void) {
        if (event === "close") setTimeout(() => cb(0), 0);
      },
      stdin: {
        write(s: string | Buffer) {
          piped = s as Buffer;
        },
        end() {},
      },
    });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    const ok = await copyImageToClipboard("/tmp/card.png", "linux", pipingSpawn, () => bytes);
    expect(ok).toBe(true);
    expect(piped).toEqual(bytes);
  });
});

describe("runShareAccept (v1.0.2 reorder): image + clipboard + tip land before the browser opens", () => {
  const URL = "https://x.com/intent/post?text=hi";

  /**
   * Builds a ShareAcceptDeps that records every call (name + key arg) into
   * `calls`, in order — including when a scenario knob makes it throw or
   * return false. Every dep is always call-recorded regardless of the knobs,
   * so `calls` is a complete, order-faithful trace of what runShareAccept did.
   */
  function recordingDeps(
    opts: { pngPath?: string | null; clipboardOk?: boolean; openOk?: boolean; throwOnWrite?: boolean } = {},
  ): { calls: string[]; deps: ShareAcceptDeps } {
    const { pngPath = "/tmp/card.png", clipboardOk = true, openOk = true, throwOnWrite = false } = opts;
    const calls: string[] = [];
    const deps: ShareAcceptDeps = {
      writeCardImage: () => {
        calls.push("writeCardImage");
        if (throwOnWrite) throw new Error("boom");
        return { svgPath: "/tmp/card.svg", pngPath };
      },
      copyImageToClipboard: async (path) => {
        calls.push(`copyImageToClipboard:${path}`);
        return clipboardOk;
      },
      revealFile: (path) => {
        calls.push(`revealFile:${path}`);
      },
      openExternal: async (url) => {
        calls.push(`openExternal:${url}`);
        return openOk;
      },
      write: (s) => {
        calls.push(`write:${s}`);
      },
    };
    return { calls, deps };
  }

  it("success path: writeCardImage -> copyImageToClipboard -> the clipboard tip -> THEN openExternal, in that order", async () => {
    const { calls, deps } = recordingDeps();
    await runShareAccept(URL, deps);
    expect(calls).toEqual([
      "writeCardImage",
      "copyImageToClipboard:/tmp/card.png",
      "write:card image on your clipboard — Cmd+V into the post\n",
      `openExternal:${URL}`,
    ]);
  });

  it("clipboard copy failed: reveals + prints the saved-path line, still entirely before the open", async () => {
    const { calls, deps } = recordingDeps({ clipboardOk: false });
    await runShareAccept(URL, deps);
    expect(calls).toEqual([
      "writeCardImage",
      "copyImageToClipboard:/tmp/card.png",
      "revealFile:/tmp/card.png",
      "write:card image saved: /tmp/card.png — attach it to the post\n",
      `openExternal:${URL}`,
    ]);
  });

  it("no PNG (svg-only): notes png-unavailable and never calls copyImageToClipboard, still before the open", async () => {
    const { calls, deps } = recordingDeps({ pngPath: null });
    await runShareAccept(URL, deps);
    expect(calls).toEqual([
      "writeCardImage",
      "revealFile:/tmp/card.svg",
      "write:card image saved: /tmp/card.svg — attach it to the post\n",
      "write:(png conversion unavailable — svg attached tools may not accept; screenshot the card above as backup)\n",
      `openExternal:${URL}`,
    ]);
  });

  it("image write throws: prints the fallback note (never touches clipboard/reveal), still opens the browser after", async () => {
    const { calls, deps } = recordingDeps({ throwOnWrite: true });
    await runShareAccept(URL, deps);
    expect(calls).toEqual([
      "writeCardImage",
      "write:(couldn't write the card image — screenshot the card above instead)\n",
      `openExternal:${URL}`,
    ]);
  });

  it("browser fails to open: the manual-open fallback line prints AFTER the clipboard tip, with the URL", async () => {
    const { calls, deps } = recordingDeps({ openOk: false });
    await runShareAccept(URL, deps);
    expect(calls).toEqual([
      "writeCardImage",
      "copyImageToClipboard:/tmp/card.png",
      "write:card image on your clipboard — Cmd+V into the post\n",
      `openExternal:${URL}`,
      `write:couldn't launch a browser — open this yourself:\n${URL}\n`,
    ]);
  });

  it("the clipboard tip is always the LAST write before openExternal is called (focus-steal fix)", async () => {
    const { calls, deps } = recordingDeps();
    await runShareAccept(URL, deps);
    const lastWriteIdx = calls.map((c) => c.startsWith("write:")).lastIndexOf(true);
    const openIdx = calls.findIndex((c) => c.startsWith("openExternal:"));
    expect(lastWriteIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(lastWriteIdx).toBeLessThan(openIdx);
  });
});
