/**
 * Pure formatting + terminal-craft helpers. No I/O, no Summary knowledge —
 * this module is the low-level toolkit render.ts builds the checkup output
 * from.
 *
 * Craft laws (pinned; do not change without re-verifying against the CLI's
 * terminal-output contract):
 *   - box() never exceeds 57 total columns (brandmark box law).
 *   - Nothing in here ever emits a clear-screen sequence.
 *   - Color helpers no-op when `enabled` is false (non-TTY / --no-color / CI).
 */

// ------------------------------------------------------------------- color

/** Minimal ANSI SGR wrapper. `enabled=false` makes every fn the identity. */
export interface Ink {
  enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  magenta(s: string): string;
  /**
   * The brand color for the recognizable box frame (v1.0.1). Bright magenta
   * (SGR 95) — chosen over bright cyan 96 because bright cyan washes out on
   * light terminal themes while bright magenta stays legible on both dark
   * and light backgrounds. One place to change if the brand color moves.
   */
  brand(s: string): string;
}

function wrap(code: string, reset = "\x1b[0m") {
  return (s: string) => `\x1b[${code}m${s}${reset}`;
}

export function makeInk(enabled: boolean): Ink {
  if (!enabled) {
    const id = (s: string) => s;
    return { enabled, bold: id, dim: id, green: id, red: id, yellow: id, cyan: id, magenta: id, brand: id };
  }
  return {
    enabled,
    bold: wrap("1"),
    dim: wrap("2"),
    green: wrap("32"),
    red: wrap("31"),
    yellow: wrap("33"),
    cyan: wrap("36"),
    magenta: wrap("35"),
    brand: wrap("95"),
  };
}

// ----------------------------------------------------------------- symbols

/**
 * Decorative glyph table. `ascii=true` (non-TTY / CI / --no-color) swaps
 * every Unicode decoration for a plain-ASCII equivalent so
 * `CI=1 node dist/cli.js | cat` is byte-clean 7-bit ASCII, matching the craft
 * law ("non-TTY/CI -> plain ASCII, no color, no stagger"). The em dash used
 * freely in prose is included here too (as `dash`) rather than left as a
 * bare literal in render.ts, so the ASCII sweep is total, not partial.
 */
export interface Sym {
  ascii: boolean;
  check: string; // done / good
  warn: string; // attention
  bullet: string; // wrapped-insight marker (»)
  dot: string; // informational-row marker (·)
  dash: string; // em dash used as a clause separator in prose
}

export function makeSym(ascii: boolean): Sym {
  if (ascii) {
    // check maps to "OK", not "[x]": an x-in-brackets reads as failure /
    // unchecked-checkbox in plain text.
    return { ascii, check: "OK", warn: "[!]", bullet: ">", dot: "-", dash: "-" };
  }
  return { ascii, check: "✓", warn: "⚠", bullet: "»", dot: "·", dash: "—" };
}

/** Strip ANSI SGR sequences (used by snapshot tests, and --md/--json paths). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// -------------------------------------------------------------------- box

const BOX_WIDTH = 57; // hard law: the score box <= 57 cols, total width incl. borders.
const BOX_INNER = BOX_WIDTH - 2;

export interface BoxLine {
  text: string;
  /** "center" | "left". Default center. */
  align?: "center" | "left";
  /** Pad char, default " ". */
  pad?: string;
}

/** Center (or left-pad) a line of *visible* text (post-ANSI-strip length used for math, raw string emitted). */
function boxRow(text: string, align: "center" | "left", side: string): string {
  const visLen = stripAnsi(text).length;
  const padTotal = Math.max(0, BOX_INNER - visLen);
  if (align === "left") {
    return `${side} ${text}${" ".repeat(Math.max(0, padTotal - 1))}${side}`;
  }
  const left = Math.floor(padTotal / 2);
  const right = padTotal - left;
  return `${side}${" ".repeat(left)}${text}${" ".repeat(right)}${side}`;
}

/** Optional frame styling for box(). */
export interface BoxFrame {
  /**
   * Brand text woven into the TOP border (v1.0.1 recognizable frame):
   * `╭─── cache-cash ─────…─────╮` (ASCII: `+--- cache-cash ---...---+`).
   * The bottom border stays plain (no text). Width stays exactly BOX_WIDTH.
   */
  brand?: string;
  /**
   * Tint applied to the border glyphs only (top border incl. brand text,
   * side bars, bottom border) — never to interior row text. Pass ink.brand;
   * it is the identity when color is disabled, so ASCII/CI output stays
   * byte-clean automatically.
   */
  tint?: (s: string) => string;
}

/**
 * Draw a fixed-width (<=57 col) box. `lines` may mix center/left aligned rows;
 * pass plain strings for centered text or {text, align} for control.
 * A line whose visible length already meets/exceeds BOX_INNER is emitted
 * unpadded (never truncated — callers are responsible for width-fitting their
 * content; this only clamps padding, matching the "verify widths" instruction).
 *
 * `ascii=true` (non-TTY / CI / --no-color) draws with plain +/-/| instead of
 * Unicode box-drawing chars — the CI smoke test
 * (`CI=1 node dist/cli.js | cat`) requires byte-clean ASCII output.
 *
 * `frame.brand` weaves the brand into the top border; `frame.tint` colors
 * the border glyphs (see BoxFrame). Branded boxes use rounded corners
 * (╭ ╮ ╰ ╯) so the frame reads as a deliberate mark, not a default table.
 */
export function box(lines: Array<string | BoxLine>, ascii = false, frame: BoxFrame = {}): string {
  const branded = frame.brand !== undefined && frame.brand.length > 0;
  const tint = frame.tint ?? ((s: string) => s);
  const h = ascii ? "-" : "─";
  const v = ascii ? "|" : "│";
  const tl = ascii ? "+" : branded ? "╭" : "┌";
  const tr = ascii ? "+" : branded ? "╮" : "┐";
  const bl = ascii ? "+" : branded ? "╰" : "└";
  const br = ascii ? "+" : branded ? "╯" : "┘";

  let top: string;
  if (branded) {
    // `╭─── cache-cash ────…────╮` — lead of 3 dashes, brand, then fill to
    // exactly BOX_WIDTH visible columns.
    const lead = `${tl}${h.repeat(3)} ${frame.brand} `;
    const fill = Math.max(0, BOX_WIDTH - lead.length - 1);
    top = lead + h.repeat(fill) + tr;
  } else {
    top = tl + h.repeat(BOX_INNER) + tr;
  }
  const bottom = bl + h.repeat(BOX_INNER) + br;

  const body = lines.map((l) => {
    const line: BoxLine = typeof l === "string" ? { text: l } : l;
    return boxRow(line.text, line.align ?? "center", tint(v));
  });
  return [tint(top), ...body, tint(bottom)].join("\n");
}

export const boxWidth = BOX_WIDTH;

/** A blank centered row inside a box (spacer). */
export const BOX_BLANK: BoxLine = { text: "" };

// ------------------------------------------------------------ number format

/** Format a dollar amount, e.g. 2500.9 -> "$2,500.90", 0 -> "$0.00". */
export function fmtDollars(n: number, decimals = 2): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Compact dollar amount for tight spaces: $2.5k, $892, $1.2M. */
export function fmtDollarsCompact(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}k`;
  return `${sign}$${abs.toFixed(2)}`;
}

/** Format a raw token count with thousands separators: 753532911 -> "753,532,911". */
export function fmtTokens(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Compact token count: 753532911 -> "753.5M", 102960 -> "103K". */
export function fmtTokensCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1000).toFixed(0)}K`;
  return `${Math.round(n)}`;
}

/** Format a fraction (0..1) as a percent string: 0.1366 -> "13.7%". */
export function fmtPct(frac: number, decimals = 1): string {
  return `${(frac * 100).toFixed(decimals)}%`;
}

/** Pluralize a simple English noun by count. */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : pluralForm ?? `${singular}s`;
}

// ------------------------------------------------------------------- bars

/**
 * Render a horizontal proportion bar using block chars, `width` cells wide.
 * `frac` is clamped to [0,1]. Non-TTY callers should still use this (it's
 * plain block-drawing chars, not color) but may prefer fmtBarAscii below.
 */
export function fmtBar(frac: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, frac));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

/** Plain-ASCII bar for non-TTY/CI (no block-drawing unicode). */
export function fmtBarAscii(frac: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, frac));
  const filled = Math.round(clamped * width);
  return "#".repeat(filled) + "-".repeat(Math.max(0, width - filled));
}

// --------------------------------------------------------------- text wrap

/** Hard-wrap a line to at most `width` cols, breaking on spaces. Never breaks a word. */
export function wrapLine(text: string, width: number): string[] {
  const words = text.split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length > width && cur) {
      out.push(cur);
      cur = w;
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);
  return out.length > 0 ? out : [""];
}
