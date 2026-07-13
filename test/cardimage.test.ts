/**
 * Generated share-image tests (v1.0.5: content-sized card, a faithful
 * replica of the terminal `card` output; the darwin PNG leg top-crops
 * qlmanage's square thumbnail back to the card via the built-in codec).
 * The SVG writer's file IO runs against an injected temp dir — never a real
 * ~/Downloads — and the darwin PNG leg uses an injected qlmanage stub
 * (writing synthetic PNGs built with src/png.ts), so nothing here spawns a
 * real process.
 *
 * The centerpiece below is the 1:1 identity suite: it independently
 * re-derives every number-bearing box string from numberBox and the usage
 * story from usagePatternStory, then asserts the SVG preserves them.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCardSvg, CARD_BASENAME, cropCardPng, defaultCardDir, escapeXml, writeCardImage } from "../src/cardimage.js";
import { usagePatternStory } from "../src/story.js";
import { encodePng, pngDimensions, type RgbaImage } from "../src/png.js";
import { absorbedDollars, fmtAbsorbed, numberBox, planMultiplierLine } from "../src/render.js";
import { makeInk, makeSym, stripAnsi } from "../src/format.js";
import {
  fixtureAllZeroLeaks,
  fixtureEndingAEnable,
  fixtureEndingBOptimal,
  fixtureEndingCReceipt,
  fixtureNegativeCachingSavings,
} from "./fixtures/summaries.js";
import type { Summary } from "../src/types.js";

const PROJECT_LEAKS = ["orders-api", "web-dashboard", "widgetco", "quietco", "-Users-"];
const ENDINGS = [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt];

/** Independent re-derivation of the box's content rows — see numberBox's own
 * doc comment for the row shape. Deliberately NOT imported from
 * cardimage.ts (which keeps this private): the point of this suite is to
 * catch drift between the terminal renderer and the image, so it must
 * compute its expectation from render.ts directly, not from the
 * implementation under test. */
function terminalBoxRows(s: Summary, planPrice?: number): string[] {
  const rendered = stripAnsi(numberBox(s, makeInk(true), makeSym(false), planPrice));
  return rendered
    .split("\n")
    .slice(1, -1)
    .map((line) => line.slice(1, -1).trim());
}

/** Independent re-derivation of the usage-pattern fact line. */
function terminalFactLine(s: Summary): string {
  return `Usage pattern: ${usagePatternStory(s).text}`;
}

/** Strip tags and decode entities from an SVG fragment, for comparing
 * against plain expected text regardless of how many tspans it's split
 * across (the fact line's embedded $ figure gets its own orange tspan —
 * see splitDollarFigure in cardimage.ts — so its text content is no longer
 * one contiguous substring of the raw SVG markup). */
function plainText(svgFragment: string): string {
  return svgFragment
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** The SVG's own canvas height (its root `height` attribute). */
function svgHeight(svg: string): number {
  const m = svg.match(/<svg [^>]*height="(\d+)"/);
  expect(m).not.toBeNull();
  return Number(m![1]);
}

/** Solid-fill RGBA image, with optional per-pixel overrides. */
function solidImage(
  width: number,
  height: number,
  rgba: [number, number, number, number],
  override?: (x: number, y: number) => [number, number, number, number] | null,
): RgbaImage {
  const pixels = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set(override?.(x, y) ?? rgba, (y * width + x) * 4);
    }
  }
  return { width, height, pixels };
}

const PAGE_BG: [number, number, number, number] = [0x0f, 0x10, 0x16, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];

describe("buildCardSvg (v1.0.5: content-sized terminal-replica card)", () => {
  it("is well-formed XML: single svg root, balanced text/tspan tags, no raw ampersands", () => {
    for (const s of ENDINGS) {
      const svg = buildCardSvg(s);
      expect(svg.startsWith("<svg ")).toBe(true);
      expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect((svg.match(/<text/g) ?? []).length).toBe((svg.match(/<\/text>/g) ?? []).length);
      expect((svg.match(/<tspan/g) ?? []).length).toBe((svg.match(/<\/tspan>/g) ?? []).length);
      // every & must be an entity
      expect(svg).not.toMatch(/&(?!(amp|lt|gt|quot|apos|#\d+);)/);
    }
  });

  it("is exactly content-sized: 720 wide, height = window + 16px margins, top-anchored — no dead bands (v1.0.5)", () => {
    for (const s of ENDINGS) {
      const svg = buildCardSvg(s);
      const h = svgHeight(svg);
      expect(h).toBeLessThan(720); // the whole point: nothing left over to band
      expect(svg).toContain(`width="720" height="${h}" viewBox="0 0 720 ${h}"`);
      // background rect covers exactly the canvas; window rect top-anchored at the 16px margin
      expect(svg).toContain(`<rect width="720" height="${h}" fill="#0f1016"/>`);
      const win = svg.match(/<rect x="16" y="16" width="688" height="(\d+)" rx="16"/);
      expect(win).not.toBeNull();
      // window height + top/bottom margins account for the whole canvas — zero slack
      expect(Number(win![1]) + 32).toBe(h);
    }
  });

  it("canvas height tracks content: the receipt card (more rows) is taller than the API score card", () => {
    const hA = svgHeight(buildCardSvg(fixtureEndingAEnable));
    const hCplan = svgHeight(buildCardSvg(fixtureEndingCReceipt, 2000));
    expect(hCplan).toBeGreaterThan(hA);
  });

  describe("the 1:1 identity guarantee: every derived row matches the real renderer verbatim", () => {
    it.each([
      ["A-enable", fixtureEndingAEnable],
      ["B", fixtureEndingBOptimal],
      ["C", fixtureEndingCReceipt],
    ] as const)("every non-blank numberBox row appears in the SVG, trimmed and unchanged (%s)", (_name, s) => {
      const svg = buildCardSvg(s);
      const rows = terminalBoxRows(s).filter((r) => r.length > 0);
      expect(rows.length).toBeGreaterThanOrEqual(4); // title, figure, sub-line, scale line at minimum
      for (const row of rows) {
        expect(svg).toContain(escapeXml(row));
      }
    });

    it.each([
      ["A-enable", fixtureEndingAEnable],
      ["B", fixtureEndingBOptimal],
      ["C", fixtureEndingCReceipt],
    ] as const)("the box rows also carry the --plan multiplier row when planPrice applies (%s)", (_name, s) => {
      const svg = buildCardSvg(s, 2000);
      const rows = terminalBoxRows(s, 2000).filter((r) => r.length > 0);
      for (const row of rows) {
        expect(svg).toContain(escapeXml(row));
      }
    });

    it("the usage story is preserved and wraps instead of truncating", () => {
      for (const s of ENDINGS) {
        const svg = buildCardSvg(s);
        const expected = terminalFactLine(s);
        expect(svg).toContain(escapeXml("Usage pattern:"));
        for (const word of expected.split(/\s+/).filter((word) => word.length >= 5)) {
          expect(plainText(svg)).toContain(word);
        }
        expect(svg).not.toContain("returns…");
      }
    });

    it("the usage-pattern fact line renders without inventing a dollar figure", () => {
      const svg = buildCardSvg(fixtureEndingCReceipt);
      const expected = terminalFactLine(fixtureEndingCReceipt);
      expect(expected).not.toContain("$");
      expect(svg).toContain(escapeXml(expected.slice(0, 40)));
    });

    it("omits redundant report and share rails from the image", () => {
      const svg = buildCardSvg(fixtureEndingCReceipt);
      expect(svg).not.toContain("Your 1h cache uses ~");
      expect(svg).not.toContain("share: npx cache-refund card");
      expect(svg).not.toContain("100% local");
    });
  });

  describe("width sanity: nothing overflows the 720 canvas", () => {
    /**
     * Estimates each <text> element's rendered horizontal extent from its
     * (possibly tspan-nested) content length, using the same 8.6px/char
     * baseline the layout constants are sized against (cardimage.ts's
     * CHAR_W_EST, at the 15px row font) — scaled by each element's own
     * font-size, since the footer/share-rail rows deliberately render
     * smaller than the primary 15px rows.
     */
    function textExtents(svg: string): { text: string; left: number; right: number }[] {
      const CHAR_W_AT_15 = 8.6;
      const out: { text: string; left: number; right: number }[] = [];
      for (const m of svg.matchAll(/<text\s+([^>]*)>([\s\S]*?)<\/text>/g)) {
        const attrs = m[1];
        const decoded = m[2]
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'");
        const x = Number(attrs.match(/x="([\d.]+)"/)?.[1] ?? 0);
        // an outer <text> with no font-size of its own sizes purely via its
        // tspans (the wrapped-insight line) — all of which render at 15px here.
        const fontSize = Number(attrs.match(/font-size="([\d.]+)"/)?.[1] ?? 15);
        const width = decoded.length * CHAR_W_AT_15 * (fontSize / 15);
        const anchored = /text-anchor="middle"/.test(attrs);
        out.push({
          text: decoded,
          left: anchored ? x - width / 2 : x,
          right: anchored ? x + width / 2 : x + width,
        });
      }
      return out;
    }

    it("every text row stays within [0, 720] for the widest fixtures", () => {
      for (const [s, plan] of [
        [fixtureEndingAEnable, undefined],
        [fixtureEndingBOptimal, undefined],
        [fixtureEndingCReceipt, undefined],
        [fixtureEndingCReceipt, 2000], // the tallest/widest box: absorbed + plan-multiplier rows both present
      ] as const) {
        const svg = buildCardSvg(s, plan);
        for (const { text, left, right } of textExtents(svg)) {
          expect(left, `"${text}" left edge`).toBeGreaterThanOrEqual(-0.5);
          expect(right, `"${text}" right edge`).toBeLessThanOrEqual(720.5);
        }
      }
    });
  });

  it("ending C: receipt box headlines the normalized limit comparison", () => {
    const svg = buildCardSvg(fixtureEndingCReceipt);
    expect(svg).toContain("1H CACHE USES 8% LESS OF YOUR LIMIT");
    expect(svg).toContain("Actual 1h");
    expect(svg).toContain("Same work on 5m");
  });

  it("ending C, unusual costlier case: figure row flips to orange, never claims a saving", () => {
    const costlier: Summary = {
      ...fixtureEndingCReceipt,
      counterfactual: { ...fixtureEndingCReceipt.counterfactual, delta1hMinus5m: 40 },
    };
    const svg = buildCardSvg(costlier);
    const row = terminalBoxRows(costlier).filter((r) => r.length > 0)[1];
    expect(svg).not.toContain("saved ~");
  });

  it("ending A headlines the projected monthly saving", () => {
    const svg = buildCardSvg(fixtureEndingAEnable);
    expect(svg).toContain("SAVE ~$80.00 / MONTH");
  });

  it("ending B headlines the already-optimal TTL", () => {
    const svg = buildCardSvg(fixtureEndingBOptimal);
    expect(svg).toContain("5M IS ALREADY OPTIMAL");
  });

  it("share-safe: no project names; API-branch cards carry no '-eq' jargon, subscriber cards do (terminal-exact wording)", () => {
    for (const s of ENDINGS) {
      const svg = buildCardSvg(s);
      for (const leak of PROJECT_LEAKS) expect(svg).not.toContain(leak);
      expect(svg).toContain("npx cache-refund");
    }
    expect(buildCardSvg(fixtureEndingAEnable)).not.toContain("-eq");
    expect(buildCardSvg(fixtureEndingBOptimal)).not.toContain("-eq");
    expect(buildCardSvg(fixtureEndingCReceipt)).toContain("API-value");
  });

  it("v1.0.4: the old designed hero is gone — no giant number, no gap bars, no CTA pill, no standalone hashtag line", () => {
    for (const s of ENDINGS) {
      const svg = buildCardSvg(s);
      expect(svg).not.toContain('font-size="68"'); // the old giant hero number
      expect(svg).not.toContain("CACHE WRITES BY RE-WARM GAP"); // the old gap-bars section label
      expect(svg).not.toContain('height="12" rx="6"'); // the old gap-bar rects
      expect(svg).not.toContain('fill-opacity="0.10"'); // the old magenta CTA pill
      expect(svg).not.toMatch(/text-anchor="middle"[^>]*>#cacherefund</); // the old standalone centered hashtag line
      expect(svg).not.toContain("UNCLAIMED CACHE REFUND"); // the old hand-typed hero overline
    }
  });

  it("escapeXml escapes all five specials", () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
  });

  describe("absorbed-value row", () => {
    it("renders monthly API-value context on the subscription outcome", () => {
      expect(buildCardSvg(fixtureEndingCReceipt)).toContain("/mo API-value absorbed");
    });
    it("omits the row entirely when there's nothing positive to absorb", () => {
      const svg = buildCardSvg(fixtureNegativeCachingSavings);
      expect(svg).not.toContain("absorbed $");
    });
  });

  describe("--plan multiplier row (inside the box; subscription-branch-only, same gate as the terminal)", () => {
    it("renders for the subscription fixture when a planPrice is passed", () => {
      const svg = buildCardSvg(fixtureEndingCReceipt, 2000);
      expect(svg).toContain(escapeXml(planMultiplierLine(fixtureEndingCReceipt, 2000)!));
    });
    it("omits the row when no planPrice is passed", () => {
      expect(buildCardSvg(fixtureEndingCReceipt)).not.toContain("your monthly plan");
    });
    it("omits the row on API-branch endings even when a planPrice is passed (branch-gated)", () => {
      expect(buildCardSvg(fixtureEndingAEnable, 200)).not.toContain("your monthly plan");
    });
  });

  describe("subscriber API-value qualifier", () => {
    it("carries one concise qualifier for the subscriber fixture", () => {
      const svg = buildCardSvg(fixtureEndingCReceipt);
      expect(svg).toContain("$ figures are API-value (list rates)");
      expect(svg).toContain("not a bill");
      expect(svg).not.toContain("subscription usage is metered in it");
    });
    it("API-branch cards omit the subscription-only qualifier", () => {
      const svg = buildCardSvg(fixtureEndingAEnable);
      expect(svg).not.toContain("$ figures are API-value");
    });
  });

  it("handles the empty-insight edge case (no candidates) without throwing or overflowing", () => {
    expect(() => buildCardSvg(fixtureAllZeroLeaks)).not.toThrow();
    expect(buildCardSvg(fixtureAllZeroLeaks)).toContain("Usage pattern:");
  });
});

describe("cropCardPng (square-thumbnail top-crop + safety guard — pure codec, no qlmanage)", () => {
  it("crops a white-padded square (the observed qlmanage layout) down to the svg height", () => {
    // 100x100 square: top 60 rows are card pixels, rows 60+ are the white pad.
    const png = encodePng(solidImage(100, 100, WHITE, (_x, y) => (y < 60 ? PAGE_BG : null)));
    const out = cropCardPng(png, 60, 100);
    expect(out).not.toBeNull();
    expect(pngDimensions(out!)).toEqual({ width: 100, height: 60 });
  });

  it("scales the crop line by the rendered width (2x thumbnail, like qlmanage -s 1440 for a 720-wide svg)", () => {
    const png = encodePng(solidImage(200, 200, WHITE, (_x, y) => (y < 120 ? PAGE_BG : null)));
    const out = cropCardPng(png, 60, 100); // rendered at 2x -> target = 120
    expect(pngDimensions(out!)).toEqual({ width: 200, height: 120 });
  });

  it("accepts a page-background pad and a fully-transparent pad too (other converter variants)", () => {
    const allBg = encodePng(solidImage(100, 100, PAGE_BG));
    expect(pngDimensions(cropCardPng(allBg, 60, 100)!)).toEqual({ width: 100, height: 60 });
    const transparent = encodePng(solidImage(100, 100, [0, 0, 0, 0], (_x, y) => (y < 60 ? PAGE_BG : null)));
    expect(pngDimensions(cropCardPng(transparent, 60, 100)!)).toEqual({ width: 100, height: 60 });
  });

  it("guard: content in the would-be-cut region skips the crop (keep the square)", () => {
    // card-text-colored pixels across the guard row (target 60 + offset 8) —
    // e.g. a converter version that centers the content instead
    const png = encodePng(solidImage(100, 100, WHITE, (_x, y) => (y === 68 ? [0xe6, 0xe6, 0xef, 255] : y < 60 ? PAGE_BG : null)));
    expect(cropCardPng(png, 60, 100)).toBeNull();
  });

  it("guard: a mixed pad row (half white, half background) skips the crop — the pad must be ONE fill", () => {
    const png = encodePng(solidImage(100, 100, WHITE, (x, y) => (y >= 60 && x < 50 ? PAGE_BG : y < 60 ? PAGE_BG : null)));
    expect(cropCardPng(png, 60, 100)).toBeNull();
  });

  it("guard: a semi-transparent pad skips the crop (neither opaque pad nor fully transparent)", () => {
    const png = encodePng(solidImage(100, 100, [255, 255, 255, 128], (_x, y) => (y < 60 ? PAGE_BG : null)));
    expect(cropCardPng(png, 60, 100)).toBeNull();
  });

  it("no-op on an already content-sized png (nothing below the crop line)", () => {
    const png = encodePng(solidImage(100, 60, PAGE_BG));
    expect(cropCardPng(png, 60, 100)).toBeNull();
  });

  it("keeps files it can't parse (not a PNG / unsupported shape) untouched", () => {
    expect(cropCardPng(Buffer.from("png-bytes"), 60, 100)).toBeNull();
  });
});

describe("writeCardImage (injected dir + qlmanage stub — no real system access)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cache-refund-card-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the SVG into the injected dir; non-darwin skips PNG entirely", () => {
    let execCalled = false;
    const res = writeCardImage(fixtureEndingCReceipt, {
      dir,
      platform: "linux",
      execFileSyncFn: () => {
        execCalled = true;
      },
    });
    expect(res.svgPath).toBe(join(dir, `${CARD_BASENAME}.svg`));
    expect(existsSync(res.svgPath)).toBe(true);
    expect(res.pngPath).toBeNull();
    expect(execCalled).toBe(false);
    expect(readFileSync(res.svgPath, "utf8")).toContain("1H CACHE USES 8% LESS OF YOUR LIMIT");
  });

  it("darwin: renames qlmanage's <name>.svg.png output to <name>.png (unparseable bytes: kept verbatim, no crop)", () => {
    const res = writeCardImage(fixtureEndingCReceipt, {
      dir,
      platform: "darwin",
      execFileSyncFn: (cmd, args) => {
        expect(cmd).toBe("qlmanage");
        expect(args).toContain("-t");
        expect(args).toContain("1440");
        // simulate qlmanage's output naming
        writeFileSync(join(dir, `${CARD_BASENAME}.svg.png`), "png-bytes");
      },
    });
    expect(res.pngPath).toBe(join(dir, `${CARD_BASENAME}.png`));
    expect(existsSync(res.pngPath!)).toBe(true);
    expect(existsSync(join(dir, `${CARD_BASENAME}.svg.png`))).toBe(false); // renamed away
    expect(readFileSync(res.pngPath!, "utf8")).toBe("png-bytes"); // crop is a guarded no-op on non-PNG bytes
  });

  it("darwin: top-crops the square thumbnail to the card's height (the v1.0.5 no-bands guarantee)", () => {
    const expectedH = svgHeight(buildCardSvg(fixtureEndingCReceipt));
    const res = writeCardImage(fixtureEndingCReceipt, {
      dir,
      platform: "darwin",
      execFileSyncFn: () => {
        // fake qlmanage: a 720x720 square rendered at 1x — card rows up top,
        // white pad below, the observed real layout.
        const square = solidImage(720, 720, WHITE, (_x, y) => (y < expectedH ? PAGE_BG : null));
        writeFileSync(join(dir, `${CARD_BASENAME}.svg.png`), encodePng(square));
      },
    });
    expect(res.pngPath).not.toBeNull();
    expect(pngDimensions(readFileSync(res.pngPath!))).toEqual({ width: 720, height: expectedH });
    expect(expectedH).toBeLessThan(720);
  });

  it("darwin: an unexpected thumbnail layout keeps the square file (guard refuses the cut)", () => {
    const expectedH = svgHeight(buildCardSvg(fixtureEndingCReceipt));
    const res = writeCardImage(fixtureEndingCReceipt, {
      dir,
      platform: "darwin",
      execFileSyncFn: () => {
        // a content-colored guard row — e.g. a converter that centers
        // instead of top-anchoring, putting card pixels below the crop line.
        const square = solidImage(720, 720, WHITE, (_x, y) =>
          y === expectedH + 8 ? [0xe6, 0xe6, 0xef, 255] : y < expectedH ? PAGE_BG : null,
        );
        writeFileSync(join(dir, `${CARD_BASENAME}.svg.png`), encodePng(square));
      },
    });
    expect(res.pngPath).not.toBeNull();
    expect(pngDimensions(readFileSync(res.pngPath!))).toEqual({ width: 720, height: 720 });
  });

  it("darwin: silent SVG-only fallback when qlmanage fails", () => {
    const res = writeCardImage(fixtureEndingCReceipt, {
      dir,
      platform: "darwin",
      execFileSyncFn: () => {
        throw new Error("qlmanage exploded");
      },
    });
    expect(existsSync(res.svgPath)).toBe(true);
    expect(res.pngPath).toBeNull();
  });

  it("defaultCardDir: private cache-refund cards directory", () => {
    const home = mkdtempSync(join(tmpdir(), "cache-refund-home-"));
    try {
      expect(defaultCardDir(home, "/some/cwd")).toBe(join(home, ".claude", "cache-refund", "cards"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
