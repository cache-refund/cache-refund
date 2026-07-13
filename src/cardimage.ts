/**
 * Generated share image (v1.0.5): a zero-dep, content-sized SVG card writer
 * that replicates the real terminal `card` output — dark terminal window,
 * traffic lights, the branded score/receipt box, exactly as printed — with
 * the numbers substituted from the live Summary. Written on share-prompt
 * accept so the post has an attachment without a manual screenshot; cli.ts
 * then best-effort copies the resulting PNG straight onto the image
 * clipboard (see share.ts's copyImageToClipboard) so the post is paste-ready.
 *
 * The canvas is exactly card-sized (v1.0.5): 720 wide, and precisely as
 * tall as the terminal window plus a 16px margin ring — no dead bands above
 * or below. The old 720x720 square existed only because qlmanage's `-t`
 * thumbnail mode emits a SQUARE PNG regardless of the source's aspect
 * ratio; instead of squaring the artwork to survive that, the darwin leg
 * now top-crops the square thumbnail back to the card's true height with
 * the built-in PNG codec (png.ts) — see cropCardPng and its safety guard
 * below. If the converter's layout ever changes, the guard keeps the
 * uncropped square (graceful degradation).
 *
 * The receipt box is pulled straight from numberBox(), while the usage story
 * is shared with the terminal through usagePatternStory(). The image keeps
 * only those two narrative layers plus a concise subscriber-only API-value
 * qualifier, avoiding duplicate report/share rails below the visual.
 *
 * Share-safe rules (same as the terminal + share templates): NEVER project
 * names — the wrapped line is derived with showProjects hardcoded false, the
 * same default `card` itself uses. Every substituted string is XML-escaped.
 *
 * PNG: X attachments need a raster, so on darwin we best-effort convert via
 * `qlmanage -t -s 1440` (ships with macOS), rename its `<name>.svg.png`
 * output, then crop the square to content; any failure silently falls back
 * a level (uncropped square, or SVG-only). `dir`/`execFileSyncFn` are
 * injectable so tests never touch a real ~/Downloads or spawn anything.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decideEnding, numberBox } from "./render.js";
import { makeInk, makeSym, stripAnsi } from "./format.js";
import { cropTop, decodePng, encodePng } from "./png.js";
import type { Summary } from "./types.js";
import { usagePatternStory } from "./story.js";

export const CARD_BASENAME = "cache-refund-card";

/** Minimal XML escaping for every substituted string. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ------------------------------------------------------------------ geometry
//
// A 720-wide canvas exactly as tall as its content: the terminal window,
// top-anchored inside a MARGIN ring. The window's height is never a guess:
// it's PAD_TOP + every row this specific Summary produces (the box's row
// count varies 6-8 depending on whether the absorbed/plan-multiplier rows
// are present, the limit-stretch line is subscription-only, the second
// footer line is subscriber-only) + PAD_BOTTOM — computed fresh per card in
// buildCard, and the canvas height follows it. That's what keeps "box rect
// sized to wrap its rows" and "canvas sized to wrap the card" true for
// every ending, not just the fixtures at hand.

const CANVAS_W = 720;
/** Outer margin between the window and the canvas edge, all four sides. */
const MARGIN = 16;
const WIN_X = MARGIN;
const WIN_W = CANVAS_W - 2 * MARGIN; // 688
const WIN_RIGHT = WIN_X + WIN_W;
const WIN_CENTER_X = WIN_X + WIN_W / 2; // 360, also the canvas center
const RADIUS = 16;
const TITLEBAR_H = 42;

/**
 * The page background. BG_RGB is the same color as channel values, for the
 * PNG crop guard's pixel compare (cropCardPng) — keep the two in sync.
 */
const BG_FILL = "#0f1016";
const BG_RGB = { r: 0x0f, g: 0x10, b: 0x16 } as const;

const PAD_X = 24; // inner left/right text inset from the window edges
const TEXT_LEFT = WIN_X + PAD_X;
const TEXT_RIGHT = WIN_RIGHT - PAD_X;
const TEXT_WIDTH = TEXT_RIGHT - TEXT_LEFT;

const ROW_H = 26;
const FONT = 15;
const FOOTER_FONT = 12;
const FOOTER_ROW_H = 19;
const PAD_TOP = 20;
const PAD_BOTTOM = 20;
const GAP_AFTER_PROMPT = 14;
const GAP_AFTER_BOX = 20;
const GAP_BEFORE_FOOTER = 12;

const BOX_W = 560;
const BOX_X = WIN_X + (WIN_W - BOX_W) / 2;
const BOX_PAD_Y = 14;
const BOX_NOTCH_W = 150;
const BOX_NOTCH_H = 18;

/**
 * Conservative average glyph width (px) at this file's row font sizes — the
 * same 8.6px/char estimate the width-sanity test uses, so the two can never
 * silently disagree. Purely a defensive cap: the box's own <=57-col law
 * (format.ts) already keeps its rows short, and the free-text rows below it
 * are bounded by the terminal's own 80-col wrap — neither comes close to
 * these caps for any real corpus, they only guard the pathological case.
 */
const CHAR_W_EST = 8.6;
const ROW_MAX_CHARS = Math.floor(TEXT_WIDTH / CHAR_W_EST);
const BOX_ROW_MAX_CHARS = Math.floor((BOX_W - 40) / CHAR_W_EST);

/** Truncate to `maxChars`, appending a single ellipsis when cut. */
function truncateRow(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/** Word-wrap without dropping text; a pathological long token is truncated. */
function wrapRows(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const rows: string[] = [];
  let row = "";
  for (const rawWord of words) {
    const word = truncateRow(rawWord, maxChars);
    const candidate = row.length === 0 ? word : `${row} ${word}`;
    if (candidate.length <= maxChars) {
      row = candidate;
    } else {
      if (row.length > 0) rows.push(row);
      row = word;
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

// -------------------------------------------------------- terminal-exact derivation

/**
 * The box's content rows, verbatim from the terminal — see the file doc
 * comment's 1:1 guarantee. numberBox() draws the exact <=57-col branded box
 * `card` prints; rendering it with color on (then stripped right back off,
 * purely to reuse its centering math) and Unicode symbols, splitting on
 * newlines, and trimming each row's border glyph + padding recovers exactly
 * what the terminal shows — never hand-typed, so this and the terminal
 * cannot drift apart. Blank spacer rows survive as "" (rendered as vertical
 * gaps below, not text nodes — see buildCardSvg's box-row loop).
 */
function boxContentRows(s: Summary, planPrice?: number, planName?: string): string[] {
  const rendered = stripAnsi(numberBox(s, makeInk(true), makeSym(false), planPrice, planName));
  const lines = rendered.split("\n");
  // First/last lines are the box's own top/bottom border (the top one
  // carries the woven brand label, e.g. "╭─── cache-refund ───…───╮"); the
  // SVG draws its border and label graphically (see the notch rect in
  // buildCardSvg) instead of reusing those box-drawing characters.
  return lines.slice(1, -1).map((line) => line.slice(1, -1).trim());
}

/**
 * The figure row's color. Not recoverable from boxContentRows (the ANSI
 * codes that carried it were stripped there, deliberately, to reuse the
 * box's plain-text centering math), so it's recomputed here from the same
 * Summary fields numberBox itself branches on: green for good news (a saved
 * receipt, or a certified-optimal score), orange for the actionable gap (an
 * unclaimed refund, or the rare costlier receipt).
 */
function figureColor(s: Summary): "green" | "orange" {
  const kind = decideEnding(s);
  if (kind === "C") return s.counterfactual.delta1hMinus5m < 0 ? "green" : "orange";
  return kind === "B" ? "green" : "orange";
}

/**
 * The top wrapped insight line, terminal-exact — including its "-eq" suffix
 * when the terminal shows one (v1.0.4: this image IS the terminal now, and
 * the footer still carries the API-value qualifier). Only the leading "» "
 * bullet is stripped; the SVG draws its own "›" glyph in front instead of
 * reusing the terminal's "»" (assets/card.svg's established convention).
 * Project-free by construction: showProjects is hardcoded false, the same
 * default `card` itself renders with.
 */
function factLine(s: Summary): string {
  return `Usage pattern: ${usagePatternStory(s).text}`;
}

/**
 * Split a fact line around its (at most one) embedded dollar figure, e.g.
 * "...cache ($453.97-eq)." -> pre="...cache ", figure="($453.97-eq)",
 * post=".". Mirrors assets/card.svg's own hand-built convention (orange
 * glyph, orange $ figure, everything else plain) — not every candidate line
 * carries a dollar figure (the streak/peak-hour/biggest-session lines
 * don't), so `figure` is null for those and the whole line renders plain.
 * Greedily includes an immediately-adjacent enclosing "(" / ")" so a
 * parenthesized figure highlights as one unit, same as the hand-built asset.
 */
// ------------------------------------------------------------------- build

interface BuiltCard {
  svg: string;
  /** The svg's total height (its `height` attribute) — the PNG crop target's source of truth. */
  canvasHeight: number;
}

/**
 * Build the content-sized SVG card: a dark terminal window replicating
 * `card`'s real output — the branded score/receipt box, the top wrapped
 * usage story, and a concise subscriber-only API-value qualifier. The canvas is
 * 720 wide and exactly windowHeight + 2*MARGIN tall, window top-anchored at
 * MARGIN (nothing to center in — the canvas hugs the card). See the file
 * doc comment for the 1:1 guarantee that keeps every substituted string
 * identical to what the terminal prints for the same Summary.
 *
 * `planPrice` (`--plan <usd>`, display-only, CLI-supplied) reaches the box's
 * "~Nx your monthly plan" row for free: it's threaded straight into
 * numberBox, the same function the terminal box uses, so there is no
 * separate plan-line code path here to keep in sync.
 */
function buildCard(s: Summary, planPrice?: number, planName?: string): BuiltCard {
  const subscriber = s.currency !== "USD";

  // ---- terminal-exact derivation (the 1:1 guarantee) ----
  const bodyRows = boxContentRows(s, planPrice, planName);
  const figColor = figureColor(s);
  const factRows = wrapRows(factLine(s), ROW_MAX_CHARS - 2); // reserve 2 cols for "› "

  const boxH = bodyRows.length * ROW_H + BOX_PAD_Y * 2;

  // ---- vertical stack, relative to the content area (just below the title bar) ----
  let cursor = PAD_TOP;
  const promptYRel = cursor;
  cursor += ROW_H + GAP_AFTER_PROMPT;
  const boxTopRel = cursor;
  cursor += boxH + GAP_AFTER_BOX;
  const factYRel = cursor;
  cursor += factRows.length * ROW_H;
  let footerYRel: number | null = null;
  if (subscriber) {
    cursor += GAP_BEFORE_FOOTER;
    footerYRel = cursor;
    cursor += FOOTER_ROW_H;
  }
  cursor += PAD_BOTTOM;

  const winH = TITLEBAR_H + cursor;
  const winY = MARGIN; // top-anchored: the canvas is content-sized, there is nothing to center in
  const canvasH = winH + 2 * MARGIN;
  const contentTop = winY + TITLEBAR_H;

  const boxY = contentTop + boxTopRel;
  const boxCx = BOX_X + BOX_W / 2;
  const notchX = BOX_X + (BOX_W - BOX_NOTCH_W) / 2;

  // ---- box interior rows: 1st non-blank = title, 2nd = figure (bold+color), rest = dim ----
  let nonBlank = 0;
  const boxRowsSvg = bodyRows
    .map((row, i) => {
      if (row === "") return ""; // blank spacer row: height already reserved, no text node
      nonBlank++;
      const rowY = boxY + BOX_PAD_Y + i * ROW_H + ROW_H / 2 + 5;
      const text = escapeXml(truncateRow(row, BOX_ROW_MAX_CHARS));
      const cls = nonBlank === 1 ? "txt" : nonBlank === 2 ? figColor : "dim";
      const weight = nonBlank === 2 ? ' font-weight="700"' : "";
      return `<text x="${boxCx}" y="${rowY}" text-anchor="middle" class="t ${cls}" font-size="${FONT}"${weight}>${text}</text>`;
    })
    .filter((l) => l.length > 0)
    .join("\n  ");

  const promptSvg = `<text x="${TEXT_LEFT}" y="${contentTop + promptYRel + ROW_H / 2 + 5}" class="t dim" font-size="${FONT}">${escapeXml("$ ")}<tspan class="t txt">${escapeXml("npx cache-refund card")}</tspan></text>`;

  const factSvg = factRows
    .map((row, index) => {
      const y = contentTop + factYRel + index * ROW_H + ROW_H / 2 + 5;
      const bullet = index === 0 ? `<tspan class="orange" font-size="${FONT}">${escapeXml("›")}</tspan>` : "";
      const indent = index === 0 ? " " : "  ";
      return `<text x="${TEXT_LEFT}" y="${y}" class="t">${bullet}<tspan class="txt" font-size="${FONT}">${escapeXml(`${indent}${row}`)}</tspan></text>`;
    })
    .join("\n  ");

  const footerSvg =
    footerYRel !== null
      ? `<text x="${TEXT_LEFT}" y="${contentTop + footerYRel + FOOTER_ROW_H / 2 + 4}" class="t dim" font-size="${FOOTER_FONT}">${escapeXml(
          "$ figures are API-value (list rates), not a bill",
        )}</text>`
      : "";

  const titleY = winY + 26;
  const dotCy = winY + 21;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${canvasH}" viewBox="0 0 ${CANVAS_W} ${canvasH}">
  <defs><style>
    .t { font-family: "SF Mono", Menlo, Monaco, "DejaVu Sans Mono", monospace; white-space: pre; }
    .dim { fill: #8b8fa3; } .txt { fill: #e6e6ef; }
    .green { fill: #3fd68f; } .orange { fill: #e8a15d; } .brand { fill: #d75fd7; font-weight: 700; }
  </style></defs>
  <rect width="${CANVAS_W}" height="${canvasH}" fill="${BG_FILL}"/>
  <rect x="${WIN_X}" y="${winY}" width="${WIN_W}" height="${winH}" rx="${RADIUS}" fill="#15161c" stroke="#2a2c37"/>
  <path d="M${WIN_X} ${winY + RADIUS} a${RADIUS} ${RADIUS} 0 0 1 ${RADIUS} -${RADIUS} h${WIN_W - 2 * RADIUS} a${RADIUS} ${RADIUS} 0 0 1 ${RADIUS} ${RADIUS} v${TITLEBAR_H - RADIUS} h-${WIN_W} z" fill="#1d1f28"/>
  <circle cx="${WIN_X + 28}" cy="${dotCy}" r="6.5" fill="#ff5f57"/><circle cx="${WIN_X + 50}" cy="${dotCy}" r="6.5" fill="#febc2e"/><circle cx="${WIN_X + 72}" cy="${dotCy}" r="6.5" fill="#28c840"/>
  <text x="${WIN_CENTER_X}" y="${titleY}" text-anchor="middle" class="t dim" font-size="13">${escapeXml("npx cache-refund")}</text>
  ${promptSvg}
  <rect x="${BOX_X}" y="${boxY}" width="${BOX_W}" height="${boxH}" rx="10" fill="none" stroke="#d75fd7" stroke-width="1.6"/>
  <rect x="${notchX}" y="${boxY - 9}" width="${BOX_NOTCH_W}" height="${BOX_NOTCH_H}" fill="#15161c"/>
  <text x="${boxCx}" y="${boxY + 5}" text-anchor="middle" class="t brand" font-size="14">${escapeXml("cache-refund")}</text>
  ${boxRowsSvg}
  ${factSvg}
  ${footerSvg}
</svg>
`;
  return { svg, canvasHeight: canvasH };
}

/** Public builder: the SVG markup for this Summary (see buildCard). */
export function buildCardSvg(s: Summary, planPrice?: number, planName?: string): string {
  return buildCard(s, planPrice, planName).svg;
}

// ---------------------------------------------------------------- png crop

/** Guard row: this many rendered px below the crop line must still be pure padding. */
const GUARD_OFFSET_PX = 8;
/** Per-channel color tolerance for the guard's pad match. */
const GUARD_TOLERANCE = 2;
/** How many pixels to sample across the guard row. */
const GUARD_SAMPLES = 12;

/**
 * The pad fills the guard accepts as provably-not-content. Verified against
 * a real thumbnail: current macOS qlmanage top-anchors the content and pads
 * the remainder of its square canvas with opaque WHITE (not the SVG's own
 * background). The page background and fully-transparent are kept as
 * accepted variants for other converter versions. None of the three can be
 * card content: the card's text inks (#e6e6ef at the lightest) sit well
 * outside the white tolerance, nothing in the card is the page background
 * edge-to-edge at full width outside the margins' own rows, and no card
 * pixel is transparent (the SVG paints a full-bleed background rect).
 */
type PadKind = "white" | "page-bg" | "transparent";

function padKind(r: number, g: number, b: number, a: number): PadKind | null {
  if (a <= GUARD_TOLERANCE) return "transparent";
  if (a !== 255) return null;
  if (r >= 255 - GUARD_TOLERANCE && g >= 255 - GUARD_TOLERANCE && b >= 255 - GUARD_TOLERANCE) return "white";
  if (
    Math.abs(r - BG_RGB.r) <= GUARD_TOLERANCE &&
    Math.abs(g - BG_RGB.g) <= GUARD_TOLERANCE &&
    Math.abs(b - BG_RGB.b) <= GUARD_TOLERANCE
  ) {
    return "page-bg";
  }
  return null;
}

/**
 * Top-crop qlmanage's square thumbnail back to the card's true height.
 * `qlmanage -t` renders the (non-square) SVG onto a square canvas with the
 * content anchored at the top and dead padding filling the remainder —
 * OBSERVED behavior, not documented, so it is never trusted blindly: before
 * cropping, GUARD_SAMPLES pixels spread across the row GUARD_OFFSET_PX
 * below the crop line must all be the SAME accepted pad fill (see PadKind)
 * — proving the region being cut is pure padding, not content. The crop
 * line scales with the thumbnail:
 * target = round(svgCanvasHeight * renderedWidth / svgCanvasWidth).
 *
 * Returns the re-encoded cropped PNG, or null to keep the original file
 * untouched: guard failed (a different qlmanage layout/version), nothing
 * below the line to cut, or the PNG isn't the 8-bit RGBA non-interlaced
 * shape qlmanage emits (png.ts's decoder throws; caught here). Deliberately
 * silent — the uncropped square is a graceful floor, not an error.
 */
export function cropCardPng(png: Buffer, svgCanvasHeight: number, svgCanvasWidth: number = CANVAS_W): Buffer | null {
  try {
    const img = decodePng(png);
    const target = Math.round((svgCanvasHeight * img.width) / svgCanvasWidth);
    const guardY = target + GUARD_OFFSET_PX;
    if (target <= 0 || target >= img.height || guardY >= img.height) return null;
    let pad: PadKind | null = null;
    for (let i = 0; i < GUARD_SAMPLES; i++) {
      const x = Math.round(((i + 0.5) / GUARD_SAMPLES) * (img.width - 1));
      const off = (guardY * img.width + x) * 4;
      const kind = padKind(img.pixels[off], img.pixels[off + 1], img.pixels[off + 2], img.pixels[off + 3]);
      if (kind === null || (pad !== null && kind !== pad)) return null;
      pad = kind;
    }
    return encodePng(cropTop(img, target));
  } catch {
    return null;
  }
}

export interface CardImageResult {
  svgPath: string;
  /** null when PNG conversion was unavailable/failed (non-darwin, or qlmanage hiccup). */
  pngPath: string | null;
}

export interface CardImageOpts {
  /** Output dir override (tests). Default: ~/Downloads if it exists, else cwd. */
  dir?: string;
  platform?: NodeJS.Platform;
  /** Injectable qlmanage runner (tests). */
  execFileSyncFn?: (cmd: string, args: string[]) => void;
  /** `--plan <usd>`, threaded to buildCardSvg — see its doc comment. */
  planPrice?: number;
  planName?: string;
}

/** Default output dir: private cache-refund artifact directory. */
export function defaultCardDir(home: string = homedir(), _cwd: string = process.cwd()): string {
  return join(home, ".claude", "cache-refund", "cards");
}

/**
 * Write the SVG (and, on darwin, best-effort PNG) card for this Summary.
 * Never throws for the PNG leg — each step degrades gracefully: qlmanage
 * failing means SVG-only; the thumbnail crop failing its safety guard means
 * the square, uncropped PNG. The happy path is a PNG exactly as tall as the
 * card: qlmanage's `-t` emits a square canvas (content top-anchored,
 * background-filled below), and cropCardPng cuts that square back down to
 * the SVG's true aspect via the built-in codec (png.ts).
 */
export function writeCardImage(s: Summary, opts: CardImageOpts = {}): CardImageResult {
  const dir = opts.dir ?? defaultCardDir();
  const platform = opts.platform ?? process.platform;
  const exec = opts.execFileSyncFn ?? ((cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: "ignore" }));
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const built = buildCard(s, opts.planPrice, opts.planName);
  const svgPath = join(dir, `${CARD_BASENAME}.svg`);
  writeFileSync(svgPath, built.svg, "utf8");

  let pngPath: string | null = null;
  if (platform === "darwin") {
    try {
      // qlmanage renders `<basename>.svg.png` into the -o dir.
      exec("qlmanage", ["-t", "-s", "1440", "-o", dir, svgPath]);
      const qlOut = join(dir, `${CARD_BASENAME}.svg.png`);
      if (existsSync(qlOut)) {
        const target = join(dir, `${CARD_BASENAME}.png`);
        renameSync(qlOut, target);
        try {
          // Cut the square thumbnail down to the card (see cropCardPng);
          // any hiccup keeps the square file — never fails the PNG leg.
          const cropped = cropCardPng(readFileSync(target), built.canvasHeight);
          if (cropped !== null) writeFileSync(target, cropped);
        } catch {
          // keep the uncropped square
        }
        pngPath = target;
      }
    } catch {
      pngPath = null; // silent SVG-only fallback
    }
  }
  return { svgPath, pngPath };
}
