/**
 * Share-CTA platform plumbing (v1.0.1, extended v1.0.2). Zero runtime deps:
 * node:child_process + node:fs only.
 *
 * Trust line unchanged: the CLI itself makes ZERO network requests. [x]/[b]
 * open the USER'S OWN BROWSER with prefilled text they read before posting
 * (an `open`/`xdg-open`/`start` of an https intent URL — the navigation
 * happens in their browser, not in this process). [c] pipes the --md block
 * to the local TEXT clipboard tool; accepting [x]/[b] also best-effort copies
 * the generated card PNG to the IMAGE clipboard (copyImageToClipboard) so it
 * can be pasted straight into the post. Everything here is optional and
 * interactive-only; non-TTY/CI runs never reach this module (cli.ts gates
 * it) — `--no-share` / `CACHE_REFUND_NO_SHARE` (noShareEnvSet) is the
 * standing opt-out cli.ts checks before any of it.
 *
 * `spawnFn` is injectable so tests can assert command construction and the
 * no-clipboard-tool fallback without touching the real system. runShareAccept
 * (below) orchestrates the [x]/[b] accept sequence itself, also fully
 * dependency-injected, so its call ORDER (image write + clipboard + tip
 * BEFORE the browser opens) is unit-testable too — see its own doc comment.
 */

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

export type SpawnLike = (
  cmd: string,
  args: string[],
  opts: { stdio: ["pipe" | "ignore", "ignore", "ignore"]; detached?: boolean },
) => {
  on(event: "error" | "close", cb: (arg?: unknown) => void): void;
  /** `write` also accepts a Buffer — the image-clipboard path (wl-copy) pipes raw PNG bytes, not text. */
  stdin?: { write(s: string | Buffer): void; end(): void } | null;
  unref?(): void;
};

/**
 * `--no-share` / `CACHE_REFUND_NO_SHARE` suppression (v1.0.2): the share
 * prompt now fires on every interactive checkup end (no more once-per-machine
 * gate — see actions.ts's removed sharePromptShown), so a standing opt-out is
 * the escape hatch. Truthy the same way settings.json env flags are: "1" or
 * "true" (case-insensitive), matching actions.ts's truthyEnvValue convention.
 */
export function noShareEnvSet(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CACHE_REFUND_NO_SHARE;
  return v === "1" || (v !== undefined && v.toLowerCase() === "true");
}

export function xIntentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

export function bskyIntentUrl(text: string): string {
  return `https://bsky.app/intent/compose?text=${encodeURIComponent(text)}`;
}

export const LINKEDIN_COMPOSE_URL = "https://www.linkedin.com/feed/?shareActive=true";

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
 * Reveal a file in the platform file manager. darwin-only (`open -R`,
 * best-effort, fire-and-forget); a no-op elsewhere per the v1.0.2 spec.
 */
export function revealFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
  spawnFn: SpawnLike = spawn as unknown as SpawnLike,
): void {
  if (platform !== "darwin") return;
  try {
    const child = spawnFn("open", ["-R", path], { stdio: ["ignore", "ignore", "ignore"], detached: true });
    child.on("error", () => {});
    child.unref?.();
  } catch {
    // best-effort only
  }
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

// ------------------------------------------------------- image clipboard

/** Minimal escaping for a path embedded in an AppleScript string literal. */
function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

interface ImageClipboardCommand {
  cmd: string;
  args: string[];
  /** true when the command needs the PNG bytes piped on stdin (wl-copy); xclip/osascript read the path themselves. */
  pipeFile?: boolean;
}

/**
 * Image-clipboard command(s) for `path`, tried IN ORDER until one succeeds.
 * darwin: a single `osascript` call (AppleScript reads the POSIX file itself,
 * no piping). linux: `wl-copy` first (piping the PNG bytes on stdin, mirrors
 * `wl-copy -t image/png < file`), falling back to `xclip -i <path>` (reads
 * the file itself, no piping) when wl-copy is unavailable. No Windows leg —
 * returns empty, which copyImageToClipboard treats as "unsupported here".
 * Exported for tests.
 */
export function imageClipboardCommandsFor(path: string, platform: NodeJS.Platform): ImageClipboardCommand[] {
  if (platform === "darwin") {
    return [
      {
        cmd: "osascript",
        args: ["-e", `set the clipboard to (read (POSIX file "${escapeAppleScriptString(path)}") as «class PNGf»)`],
      },
    ];
  }
  if (platform === "linux") {
    return [
      { cmd: "wl-copy", args: ["-t", "image/png"], pipeFile: true },
      { cmd: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-i", path] },
    ];
  }
  return [];
}

/** Run one image-clipboard command, resolving true only on a clean (code 0) exit. Never throws. */
function runImageClipboardCommand(
  path: string,
  { cmd, args, pipeFile }: ImageClipboardCommand,
  spawnFn: SpawnLike,
  readFileFn: (p: string) => Buffer,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawnFn(cmd, args, { stdio: [pipeFile ? "pipe" : "ignore", "ignore", "ignore"] });
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
      if (pipeFile) {
        child.stdin?.write(readFileFn(path));
        child.stdin?.end();
      }
    } catch {
      resolve(false);
    }
  });
}

/**
 * Copy the PNG at `path` itself onto the system IMAGE clipboard (v1.0.2,
 * distinct from copyToClipboard's TEXT path above) so a post can be pasted
 * straight in — see cli.ts's maybeSharePrompt for the fallback message when
 * this resolves false. Tries each of imageClipboardCommandsFor's commands in
 * order until one exits clean; best-effort throughout, never throws, and
 * resolves false (never rejects) on an unsupported platform or when every
 * tool is missing.
 */
export async function copyImageToClipboard(
  path: string,
  platform: NodeJS.Platform = process.platform,
  spawnFn: SpawnLike = spawn as unknown as SpawnLike,
  readFileFn: (p: string) => Buffer = (p) => readFileSync(p),
): Promise<boolean> {
  for (const command of imageClipboardCommandsFor(path, platform)) {
    if (await runImageClipboardCommand(path, command, spawnFn, readFileFn)) return true;
  }
  return false;
}

export interface LinkedInShareDeps {
  copyToClipboard: (text: string) => Promise<boolean>;
  revealFile: (path: string) => void;
  openExternal: (url: string) => Promise<boolean>;
  write: (text: string) => void;
}

/** LinkedIn does not reliably accept prefilled post text in its web composer. */
export async function runLinkedInShare(text: string, imagePath: string, deps: LinkedInShareDeps): Promise<void> {
  const copied = await deps.copyToClipboard(text);
  deps.revealFile(imagePath);
  deps.write(
    copied
      ? `LinkedIn does not support prefilled post text — text copied to clipboard. Paste it, then attach the card image:\n${imagePath}\n`
      : `LinkedIn does not support prefilled post text — copy the share text from the report, then attach the card image:\n${imagePath}\n`,
  );
  if (!(await deps.openExternal(LINKEDIN_COMPOSE_URL))) {
    deps.write(`couldn't launch a browser — open this yourself:\n${LINKEDIN_COMPOSE_URL}\n`);
  }
}

// ------------------------------------------------------- share-accept order

/** Dependencies for runShareAccept, injected so tests can assert call order without touching the real filesystem, clipboard, or a real browser spawn. */
export interface ShareAcceptDeps {
  /** Writes the card image (cardimage.ts's writeCardImage), pre-bound to the Summary being shared. */
  writeCardImage: () => { svgPath: string; pngPath: string | null };
  copyImageToClipboard: (path: string) => Promise<boolean>;
  revealFile: (path: string) => void;
  openExternal: (url: string) => Promise<boolean>;
  /** stdout sink (process.stdout.write in production). */
  write: (s: string) => void;
  /**
   * Pause between the clipboard tip and the browser launch, so the line
   * registers before the browser steals window focus. Production: ~1s real
   * sleep; tests inject a no-op.
   */
  pauseBeforeOpen?: () => Promise<void>;
}

/**
 * The share-accept sequence for [x]/[b]: write the card image, copy it to
 * the clipboard, and print the tip — ALL BEFORE opening the browser.
 *
 * Real UX bug this fixes: the browser used to open FIRST. On most desktops
 * that steals window focus the instant it launches, which raced the
 * clipboard tip that printed right after — so the user's terminal lost
 * focus before they ever saw "card image on your clipboard," and the tip
 * scrolled by unread. Doing the image write + clipboard copy + tip first
 * guarantees the tip hits stdout while the terminal still has focus; only
 * THEN does the (possibly focus-stealing) browser spawn happen.
 */
export async function runShareAccept(url: string, deps: ShareAcceptDeps): Promise<void> {
  try {
    const { svgPath, pngPath } = deps.writeCardImage();
    const file = pngPath ?? svgPath;
    const clipped = pngPath ? await deps.copyImageToClipboard(pngPath) : false;
    if (clipped) {
      deps.write("card image on your clipboard — Cmd+V into the post\n");
    } else {
      deps.revealFile(file);
      deps.write(`card image saved: ${file} — attach it to the post\n`);
      if (!pngPath) {
        deps.write(
          "(png conversion unavailable — svg attached tools may not accept; screenshot the card above as backup)\n",
        );
      }
    }
  } catch {
    // Image generation is a convenience — never let it break the share flow.
    deps.write("(couldn't write the card image — screenshot the card above instead)\n");
  }

  // One readable beat before the browser takes focus.
  if (deps.pauseBeforeOpen) await deps.pauseBeforeOpen();

  const opened = await deps.openExternal(url);
  if (!opened) {
    deps.write(`couldn't launch a browser — open this yourself:\n${url}\n`);
  }
}
