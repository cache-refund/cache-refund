/**
 * Share-CTA platform plumbing (v1.0.1). Zero-dep: node:child_process only.
 *
 * Trust line unchanged: the CLI itself makes ZERO network requests. [x]/[b]
 * open the USER'S OWN BROWSER with prefilled text they read before posting
 * (an `open`/`xdg-open`/`start` of an https intent URL — the navigation
 * happens in their browser, not in this process). [c] pipes the --md block
 * to the local clipboard tool. Everything here is optional and interactive-
 * only; non-TTY/CI runs never reach this module (cli.ts gates it).
 *
 * `spawnFn` is injectable so tests can assert command construction and the
 * no-clipboard-tool fallback without touching the real system.
 */

import { spawn } from "node:child_process";

export type SpawnLike = (
  cmd: string,
  args: string[],
  opts: { stdio: ["pipe" | "ignore", "ignore", "ignore"]; detached?: boolean },
) => {
  on(event: "error" | "close", cb: (arg?: unknown) => void): void;
  stdin?: { write(s: string): void; end(): void } | null;
  unref?(): void;
};

export const SHARE_PROMPT_LINE =
  "share this? [x] post to X · [b] Bluesky · [c] copy for Slack · [Enter] skip ";

export function xIntentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

export function bskyIntentUrl(text: string): string {
  return `https://bsky.app/intent/compose?text=${encodeURIComponent(text)}`;
}

/** Platform's browser-open command + args for a URL. Exported for tests. */
export function openCommandFor(url: string, platform: NodeJS.Platform): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return { cmd: "xdg-open", args: [url] };
}

/** Platform's clipboard command + args. Exported for tests. */
export function clipboardCommandFor(platform: NodeJS.Platform): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "pbcopy", args: [] };
  if (platform === "win32") return { cmd: "clip", args: [] };
  return { cmd: "xclip", args: ["-selection", "clipboard"] };
}

/**
 * Open `url` in the user's default browser. Fire-and-forget (detached,
 * unref'd); resolves false if the opener itself can't spawn (rare — the
 * caller then prints the URL so the user can open it by hand).
 */
export function openExternal(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnFn: SpawnLike = spawn as unknown as SpawnLike,
): Promise<boolean> {
  const { cmd, args } = openCommandFor(url, platform);
  return new Promise((resolve) => {
    try {
      const child = spawnFn(cmd, args, { stdio: ["ignore", "ignore", "ignore"], detached: true });
      let settled = false;
      child.on("error", () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      // Give the spawn a beat to fail with ENOENT; otherwise assume launched.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          child.unref?.();
          resolve(true);
        }
      }, 150);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Copy `text` to the system clipboard. Resolves false when no clipboard tool
 * exists (e.g. a Linux box without xclip) — the caller falls back to
 * printing the block with "copy the block above".
 */
export function copyToClipboard(
  text: string,
  platform: NodeJS.Platform = process.platform,
  spawnFn: SpawnLike = spawn as unknown as SpawnLike,
): Promise<boolean> {
  const { cmd, args } = clipboardCommandFor(platform);
  return new Promise((resolve) => {
    try {
      const child = spawnFn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      let settled = false;
      child.on("error", () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      child.on("close", (code?: unknown) => {
        if (!settled) {
          settled = true;
          resolve(code === 0);
        }
      });
      child.stdin?.write(text);
      child.stdin?.end();
    } catch {
      resolve(false);
    }
  });
}
