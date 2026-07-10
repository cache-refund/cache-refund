/**
 * Generated share image (v1.0.2): a zero-dep, 720x720 SQUARE SVG card writer
 * — dark terminal window, traffic lights, magenta branded CTA pill — with
 * the numbers substituted from the live Summary. Written on share-prompt
 * accept so the post has an attachment without a manual screenshot; cli.ts
 * then best-effort copies the resulting PNG straight onto the image
 * clipboard (see share.ts's copyImageToClipboard) so the post is paste-ready.
 *
 * Square canvas is deliberate, not cosmetic: qlmanage's `-t` thumbnail mode
 * renders a square thumbnail regardless of the source's aspect ratio, so a
 * non-square source (the old 720x440 card) came out letterboxed/padded after
 * conversion. At 720x720 the thumbnail IS the artwork — no crop/sips step
 * needed before or after `qlmanage -t -s 1440` (kept as-is below).
 *
 * Ending-aware hero block (the one huge number, replaces v1's smaller
 * score-box figure): C leads with the API-value receipt delta, A with the
 * unclaimed-refund delta, B with the bare efficiency score — see
 * heroBlock() below. Two more dim, optional lines flex the scale further:
 * "absorbed $X of API-value" under the stat row (any branch, positive-only)
 * and "~Nx your monthly plan" under the hero sub-line (subscription + the
 * `--plan <usd>` flag only) — both single-sourced from render.ts so the
 * terminal card and this SVG never drift apart on the same figure.
 *
 * Share-safe rules (same as the terminal + share templates): NEVER project
 * names, no "-eq" jargon — subscriber figures say "in API-value" and the
 * footer carries the qualifier. Every substituted string is XML-escaped.
 *
 * PNG: X attachments need a raster, so on darwin we best-effort convert via
 * `qlmanage -t -s 1440` (ships with macOS) and rename its `<name>.svg.png`
 * output; any failure silently falls back to SVG-only. `dir`/`execFileSyncFn`
 * are injectable so tests never touch a real ~/Downloads or spawn anything.
 */

import { execFileSync } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { absorbedDollars, decideEnding, fmtAbsorbed, limitMultiples, planMultiplierLine, wrappedLines } from "./render.js";
import { fmtTokensCompact, makeInk, makeSym } from "./format.js";
import type { Summary } from "./types.js";

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

/** `$` + rounded-to-the-dollar magnitude, comma-grouped, NEVER cents — the hero is a headline, not a ledger line. */
function fmtHeroDollars(n: number): string {
  return `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}

/** Truncate to `max` chars (default 64, the hero fact line's budget), appending a single ellipsis when cut. */
function truncateFact(s: string, max = 64): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** The top wrapped insight, share-safe (no project — showProjects is always false here) and terminal-jargon-free (no "-eq"). */
function factLine(s: Summary): string {
  const lines = wrappedLines(s, makeInk(false), makeSym(false), false);
  const first = lines[1] ?? "";
  const clean = first
    .replace(/^\s*»\s*/, "")
    .replace(/-eq\b/g, "")
    .trim();
  return truncateFact(clean);
}

/** Plain-English window phrase for the hero sub-line, e.g. "last 90 days" / "the 42-day span analyzed". */
function windowPhraseLong(s: Summary): string {
  return s.window.mode === "days" && s.window.days != null
    ? `last ${s.window.days} days`
    : `the ${Math.round(s.counterfactual.spanDays)}-day span analyzed`;
}

interface HeroBlock {
  overline: string;
  hero: string;
  heroClass: "green" | "orange";
  sub: string;
}

/**
 * The ending-aware hero: overline + huge headline number + one-line sub,
 * mirroring the terminal's three verdict shapes (decideEnding's A/B/C, with
 * A-enable and A-revert sharing the same "unclaimed refund" framing — both
 * are "one config line recovers it", just in opposite directions).
 */
function heroBlock(s: Summary): HeroBlock {
  const kind = decideEnding(s);
  if (kind === "C") {
    const delta = s.counterfactual.delta1hMinus5m;
    const saved = delta < 0;
    return {
      overline: "YOUR 1H CACHE RECEIPT",
      hero: fmtHeroDollars(delta),
      heroClass: saved ? "green" : "orange",
      // Honest flip for the (unusual) subscriber whose 1h TTL cost more than
      // 5m would have this window — never claim "saved" on a positive delta
      // (same discipline as render.ts's receiptHeadline/cachingSavedLine).
      sub: saved
        ? `saved in API-value · ${windowPhraseLong(s)}`
        : `costlier than the default · ${windowPhraseLong(s)}`,
    };
  }
  if (kind === "B") {
    return {
      overline: "CERTIFIED OPTIMAL",
      hero: s.efficiencyScore.toFixed(1),
      heroClass: "green",
      sub: "the default cache setting is right for how you work",
    };
  }
  // A-enable / A-revert: the recommender's and validator's actionable gap —
  // same copy either way, since both reduce to "switch the TTL, recover this".
  return {
    overline: "UNCLAIMED CACHE REFUND",
    hero: fmtHeroDollars(s.counterfactual.delta1hMinus5m),
    heroClass: "orange",
    sub: "left on the table · one config line recovers it",
  };
}

/** Gap-bucket bar width in px (track is 300px wide): pct/100*300, floored at 6px so a nonzero share is never invisible. */
function barWidth(pctRaw: number): number {
  if (pctRaw <= 0) return 0;
  return Math.max(6, Math.round((pctRaw / 100) * 300));
}

/**
 * Build the 720x720 SVG card. Ending-aware like the terminal box — see
 * heroBlock(). Every substituted string is XML-escaped (composed lines are
 * escaped whole, matching the existing convention: build the text, then
 * escape it once, rather than escaping numeric pieces separately).
 *
 * `planPrice` (`--plan <usd>`, display-only, CLI-supplied) renders the
 * "~Nx your monthly plan" line right under the hero sub-line when the
 * branch is subscription — see render.ts's planMultiplierLine, the single
 * source of truth this and the terminal box both format from.
 */
export function buildCardSvg(s: Summary, planPrice?: number): string {
  const hero = heroBlock(s);
  const statLine = escapeXml(
    `efficiency ${s.efficiencyScore.toFixed(1)} / 100   ·   ` +
      `${fmtTokensCompact(s.tokens.creationTotal + s.tokens.readTotal)} tokens   ·   ` +
      `${s.scope.sessions.toLocaleString()} sessions`,
  );
  const fact = escapeXml(factLine(s));
  const subscriber = s.currency !== "USD";

  const bucketTotal = s.buckets.creationTotal > 0 ? s.buckets.creationTotal : 1;
  const pctWarm = (s.buckets.warm / bucketTotal) * 100;
  const pctRec = (s.buckets.recoverable / bucketTotal) * 100;
  const pctCold = (s.buckets.cold / bucketTotal) * 100;
  const pctWarmText = escapeXml(`${pctWarm.toFixed(1)}%`);
  const pctRecText = escapeXml(`${pctRec.toFixed(1)}%`);
  const pctColdText = escapeXml(`${pctCold.toFixed(1)}%`);

  // "~Nx your monthly plan" — under the hero sub-line, in the gap already
  // there between it (y=240) and the stat row (y=292); omitted (no line,
  // no gap left behind) when --plan wasn't passed or the branch isn't
  // subscription (planMultiplierLine's own gate).
  const plan = planMultiplierLine(s, planPrice);
  const planSvgLine =
    plan !== null
      ? `\n  <text x="360" y="266" text-anchor="middle" class="t dim" font-size="14">${escapeXml(plan)}</text>`
      : "";

  // "absorbed $X of API-value" — under the stat row; omitted (no line, no
  // gap left behind) when there's nothing positive to have absorbed
  // (absorbedDollars' own omit rule — see render.ts).
  const absorbed = absorbedDollars(s);
  const absorbedSvgLine =
    absorbed !== null
      ? `\n  <text x="360" y="316" text-anchor="middle" class="t dim" font-size="14">${escapeXml(fmtAbsorbed(absorbed))}</text>`
      : "";

  // Limit framing (subscription): between the fact line (y=478) and the CTA
  // pill (y=530) — the reader's own currency is their usage limit, and this
  // is the line that answers "how does a $200 plan absorb $67k". Omitted
  // (limitMultiples' gates) off-branch or when 1h isn't actually ahead.
  const stretch = limitMultiples(s);
  const stretchSvgLine =
    stretch !== null
      ? `\n  <text x="360" y="506" text-anchor="middle" class="t dim" font-size="13">${escapeXml(`same work on a 5m cache: ~${stretch.pct5m}% more of your usage limit`)}</text>`
      : "";

  const footerSub = subscriber
    ? `\n  <text x="360" y="690" text-anchor="middle" class="t dim" font-size="12">${escapeXml("$ figures are API-value (list rates) — subscription usage is metered in it, not billed")}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720" viewBox="0 0 720 720">
  <defs><style>
    .t { font-family: "SF Mono", Menlo, Monaco, "DejaVu Sans Mono", monospace; white-space: pre; }
    .dim { fill: #8b8fa3; } .txt { fill: #e6e6ef; }
    .green { fill: #3fd68f; } .orange { fill: #e8a15d; } .brand { fill: #d75fd7; }
  </style></defs>
  <rect width="720" height="720" fill="#0f1016"/>
  <rect x="16" y="16" width="688" height="688" rx="16" fill="#15161c" stroke="#2a2c37"/>
  <path d="M16 32 a16 16 0 0 1 16 -16 h656 a16 16 0 0 1 16 16 v26 h-688 z" fill="#1d1f28"/>
  <circle cx="44" cy="37" r="6.5" fill="#ff5f57"/><circle cx="66" cy="37" r="6.5" fill="#febc2e"/><circle cx="88" cy="37" r="6.5" fill="#28c840"/>
  <text x="360" y="42" text-anchor="middle" class="t dim" font-size="13">npx cache-refund</text>
  <text x="360" y="130" text-anchor="middle" class="t dim" font-size="14" letter-spacing="3">${escapeXml(hero.overline)}</text>
  <text x="360" y="205" text-anchor="middle" class="t ${hero.heroClass}" font-size="68" font-weight="700">${escapeXml(hero.hero)}</text>
  <text x="360" y="240" text-anchor="middle" class="t dim" font-size="16">${escapeXml(hero.sub)}</text>${planSvgLine}
  <text x="360" y="292" text-anchor="middle" class="t txt" font-size="16">${statLine}</text>${absorbedSvgLine}
  <text x="80" y="359" class="t dim" font-size="12" letter-spacing="2">CACHE WRITES BY RE-WARM GAP</text>
  <rect x="200" y="376" width="300" height="12" rx="6" fill="#232530"/><rect x="200" y="376" width="${barWidth(pctWarm)}" height="12" rx="6" fill="#3fd68f"/>
  <text x="80" y="387" class="t dim" font-size="13">warm</text><text x="516" y="387" class="t txt" font-size="13">${pctWarmText}</text>
  <rect x="200" y="398" width="300" height="12" rx="6" fill="#232530"/><rect x="200" y="398" width="${barWidth(pctRec)}" height="12" rx="6" fill="#e0b856"/>
  <text x="80" y="409" class="t dim" font-size="13">recoverable</text><text x="516" y="409" class="t txt" font-size="13">${pctRecText}</text>
  <rect x="200" y="420" width="300" height="12" rx="6" fill="#232530"/><rect x="200" y="420" width="${barWidth(pctCold)}" height="12" rx="6" fill="#949cb8"/>
  <text x="80" y="431" class="t dim" font-size="13">cold</text><text x="516" y="431" class="t txt" font-size="13">${pctColdText}</text>
  <text x="80" y="478" class="t" font-size="14"><tspan class="orange">›</tspan><tspan class="txt"> ${fact}</tspan></text>${stretchSvgLine}
  <rect x="80" y="530" width="560" height="64" rx="12" fill="#d75fd7" fill-opacity="0.10" stroke="#d75fd7" stroke-width="1.5"/>
  <text x="360" y="570" text-anchor="middle" class="t brand" font-size="22" font-weight="700">npx cache-refund</text>
  <text x="360" y="640" text-anchor="middle" class="t dim" font-size="13">#cacherefund</text>
  <text x="360" y="672" text-anchor="middle" class="t dim" font-size="12">100% local · token counts + timestamps · nothing leaves this machine</text>${footerSub}
</svg>
`;
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
}

/** Default output dir: ~/Downloads when present, else the current directory. */
export function defaultCardDir(home: string = homedir(), cwd: string = process.cwd()): string {
  const downloads = join(home, "Downloads");
  return existsSync(downloads) ? downloads : cwd;
}

/**
 * Write the SVG (and, on darwin, best-effort PNG) card for this Summary.
 * Never throws for the PNG leg — SVG-only is the graceful floor. The square
 * 720x720 canvas means qlmanage's `-t` thumbnail needs no post-processing:
 * its square output IS the full card, at any `-s` size — no sips/crop step.
 */
export function writeCardImage(s: Summary, opts: CardImageOpts = {}): CardImageResult {
  const dir = opts.dir ?? defaultCardDir();
  const platform = opts.platform ?? process.platform;
  const exec = opts.execFileSyncFn ?? ((cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: "ignore" }));

  const svgPath = join(dir, `${CARD_BASENAME}.svg`);
  writeFileSync(svgPath, buildCardSvg(s, opts.planPrice), "utf8");

  let pngPath: string | null = null;
  if (platform === "darwin") {
    try {
      // qlmanage renders `<basename>.svg.png` into the -o dir.
      exec("qlmanage", ["-t", "-s", "1440", "-o", dir, svgPath]);
      const qlOut = join(dir, `${CARD_BASENAME}.svg.png`);
      if (existsSync(qlOut)) {
        const target = join(dir, `${CARD_BASENAME}.png`);
        renameSync(qlOut, target);
        pngPath = target;
      }
    } catch {
      pngPath = null; // silent SVG-only fallback
    }
  }
  return { svgPath, pngPath };
}
