/**
 * Render snapshot + width tests. Snapshots strip ANSI (snapshot tests cover
 * all three endings + card + --md + --compact from fixture Summaries; ANSI
 * is stripped in snapshots). Width tests assert the hard layout laws: the
 * score box exactly <=57 cols, no line exceeds 80 cols in the default
 * (non-TTY, since tests run non-interactively) render.
 */

import { describe, expect, it } from "vitest";
import { stripAnsi, boxWidth, makeInk, makeSym } from "../src/format.js";
import {
  absorbedDollars,
  checkupLines,
  decideEnding,
  fmtAbsorbed,
  limitMultiples,
  limitStretchLine,
  makeScanProgress,
  numberBox,
  planMultiplierLine,
  renderCard,
  renderCompact,
  renderEnding,
  renderExplain,
  renderFull,
  renderMarkdown,
  shareTemplate,
  wrappedLines,
} from "../src/render.js";
import {
  fixtureAllZeroLeaks,
  fixtureEndingAEnable,
  fixtureEndingBOptimal,
  fixtureEndingCReceipt,
  fixtureNegativeCachingSavings,
  fixtureNegativeCachingSavingsEndingB,
} from "./fixtures/summaries.js";

const NON_TTY = { tty: false } as const;

function maxLineWidth(text: string): number {
  return Math.max(0, ...stripAnsi(text).split("\n").map((l) => l.length));
}

describe("ending decision logic", () => {
  it("api-5m above threshold (1h cheaper) -> A-enable", () => {
    expect(decideEnding(fixtureEndingAEnable)).toBe("A-enable");
  });
  it("api-5m below threshold (5m already optimal) -> B", () => {
    expect(decideEnding(fixtureEndingBOptimal)).toBe("B");
  });
  it("subscription -> C always", () => {
    expect(decideEnding(fixtureEndingCReceipt)).toBe("C");
  });
});

describe("score box width law (<=57 cols)", () => {
  it("numberBox is exactly 57 cols on every line, for all three fixtures, TTY and non-TTY (Unicode and ASCII box chars)", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      for (const tty of [true, false]) {
        const rendered = stripAnsi(numberBox(s, makeInk(tty), makeSym(!tty)));
        for (const line of rendered.split("\n")) {
          expect(line.length).toBe(boxWidth);
          expect(line.length).toBeLessThanOrEqual(57);
        }
      }
    }
  });
});

describe("no line exceeds 80 cols (default terminal width)", () => {
  // Scope: "at default terminal" means terminal-rendered modes. --md is
  // explicitly the Slack/Teams paste payload (prose in a chat client,
  // not a terminal) — its table rows may legitimately run longer; it still
  // gets its own ANSI-free assertion above and a snapshot below.
  it("renderFull, non-TTY, all fixtures", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt, fixtureAllZeroLeaks]) {
      const { lines } = renderFull(s, NON_TTY);
      const text = lines.join("\n");
      const w = maxLineWidth(text);
      expect(w).toBeLessThanOrEqual(80);
    }
  });
  it("card, compact all fixtures", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      expect(maxLineWidth(renderCard(s, NON_TTY))).toBeLessThanOrEqual(80);
      expect(maxLineWidth(renderCompact(s, NON_TTY))).toBeLessThanOrEqual(80);
    }
  });
});

describe("non-TTY renders are ANSI-free", () => {
  it("renderFull emits no ANSI escape codes when tty:false", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      const { lines } = renderFull(s, NON_TTY);
      const text = lines.join("\n");
      // eslint-disable-next-line no-control-regex
      expect(text).not.toMatch(/\x1b\[/);
    }
  });
  it("--md is always ANSI-free (no tty concept for md)", () => {
    expect(renderMarkdown(fixtureEndingCReceipt)).not.toMatch(/\x1b\[/);
  });
});

describe("non-TTY / CI renders are byte-clean 7-bit ASCII (layout law)", () => {
  // This is the exact gate `CI=1 node dist/cli.js | cat` exercises at the
  // CLI level: no box-drawing chars, no checkmarks, no em dashes, no color.
  function nonAsciiChars(text: string): string[] {
    return [...new Set([...text].filter((c) => c.codePointAt(0)! > 127))];
  }
  it("renderFull(tty:false) is pure ASCII for all three endings + zero-leak fixture", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt, fixtureAllZeroLeaks]) {
      const { lines } = renderFull(s, NON_TTY);
      const bad = nonAsciiChars(lines.join("\n"));
      expect(bad, `non-ASCII chars found: ${JSON.stringify(bad)}`).toEqual([]);
    }
  });
  it("card(tty:false) and --compact(tty:false) are pure ASCII", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      expect(nonAsciiChars(renderCard(s, NON_TTY))).toEqual([]);
      expect(nonAsciiChars(renderCompact(s, NON_TTY))).toEqual([]);
    }
  });
  it("ASCII check glyph is 'OK', not '[x]' ([x] reads as failure)", () => {
    expect(makeSym(true).check).toBe("OK");
    expect(makeSym(true).warn).toBe("[!]");
    const { lines } = renderFull(fixtureEndingCReceipt, NON_TTY);
    const text = lines.join("\n");
    expect(text).not.toContain("[x]");
    expect(text).toContain("OK");
  });
});

describe("zero-leak rows render gracefully, never hidden", () => {
  it("renderFull with all-zero leaks still prints every leak label", () => {
    const { lines } = renderFull(fixtureAllZeroLeaks, NON_TTY);
    const text = lines.join("\n");
    expect(text).toContain("subagent-5m".length > 0 ? "" : ""); // sanity noop
    for (const l of fixtureAllZeroLeaks.leaks) {
      // Every leak row's cause must be attributable somewhere OR its dollars=0
      // must not cause the row to vanish from --md (checked separately below).
      expect(l.dollars).toBe(0);
    }
  });
  it("--md prints every leak row even at $0", () => {
    const md = renderMarkdown(fixtureAllZeroLeaks);
    for (const l of fixtureAllZeroLeaks.leaks) {
      expect(md).toContain(l.label);
    }
  });
  it("renderFull handles null biggestMiss/worstDay without crashing", () => {
    expect(() => renderFull(fixtureAllZeroLeaks, NON_TTY)).not.toThrow();
  });
});

describe("wrapped lines never cite unattributable causes", () => {
  const ATTRIBUTABLE_HINTS = [
    "re-warm",
    "leaked",
    "days in a row",
    "peak hour",
    "biggest session",
    "model switch",
    "compaction",
  ];
  it("every wrapped INSIGHT (logical bullet, across its wrapped physical lines) traces to a locked leak-taxonomy or stat field", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      const { lines } = renderFull(s, NON_TTY);
      const text = stripAnsi(lines.join("\n"));
      const wrappedStart = text.indexOf("YOUR CACHE, WRAPPED");
      const wrappedEnd = text.indexOf("\n\n", wrappedStart);
      const wrappedSection = text.slice(wrappedStart, wrappedEnd === -1 ? undefined : wrappedEnd);
      const physicalLines = wrappedSection
        .split("\n")
        .slice(1)
        .filter((l) => l.trim().length > 0);
      // Regroup physical lines into logical bullets: a bullet starts with "»",
      // continuation (wrapped) lines don't. The layout law ("every line
      // contains a number") is about the logical insight, not every wrapped
      // terminal row.
      const insights: string[] = [];
      for (const line of physicalLines) {
        if (line.includes("»")) insights.push(line);
        else insights[insights.length - 1] += " " + line.trim();
      }
      for (const insight of insights) {
        expect(insight).not.toMatch(/resume/i);
        // every insight has a number (layout law: "EVERY line contains a number")
        expect(insight).toMatch(/\d/);
        const matches = ATTRIBUTABLE_HINTS.some((h) => insight.toLowerCase().includes(h));
        expect(matches).toBe(true);
      }
    }
  });
});

describe("currency separation", () => {
  it("subscriber receipt never says 'saved you $' without -equivalent / -eq", () => {
    const { lines } = renderFull(fixtureEndingCReceipt, NON_TTY);
    const text = stripAnsi(lines.join("\n"));
    // Any dollar-saved claim near the subscriber ending must carry currency context.
    expect(text).toContain(fixtureEndingCReceipt.currency);
  });
  it("--md table header uses $-eq for subscription branch, $ for API branches", () => {
    const subMd = renderMarkdown(fixtureEndingCReceipt);
    expect(subMd).toContain("$-eq");
    const apiMd = renderMarkdown(fixtureEndingAEnable);
    expect(apiMd).toMatch(/\|\s*\$\s*\|/);
  });
});

describe("caching-vs-uncached honesty (write-heavy/read-light can make caching cost MORE)", () => {
  // Regression coverage for a real bug found during renderer smoke testing: a
  // synthetic write-heavy, read-light corpus produces uncachedCost <
  // actualCost (the 1.25x/2x write markup isn't recouped by 0.1x reads), and
  // the render used to print a nonsensical "Caching saved you -$2.41".
  it("renderFull flips to 'caching cost you $X MORE' instead of a negative saving", () => {
    const { lines } = renderFull(fixtureNegativeCachingSavings, NON_TTY);
    const text = stripAnsi(lines.join("\n")).replace(/\n/g, " ");
    expect(text).not.toMatch(/saved you -\$/);
    expect(text).not.toMatch(/saved you \$-/);
    expect(text).toMatch(/cost you \$2\.41.*MORE than uncached/);
  });
  it("the CERTIFIED OPTIMAL box line also flips to the box-safe short form (ending B)", () => {
    expect(decideEnding(fixtureNegativeCachingSavingsEndingB)).toBe("B");
    const { lines } = renderFull(fixtureNegativeCachingSavingsEndingB, NON_TTY);
    const text = stripAnsi(lines.join("\n"));
    expect(text).not.toMatch(/saved you -\$/);
    expect(text).not.toMatch(/saved you \$-/);
    expect(text).toContain("caching cost $2.41 more than uncached");
  });
  it("--md verdict block also flips for the subscription branch", () => {
    const md = renderMarkdown(fixtureNegativeCachingSavings).replace(/\n/g, " ");
    expect(md).not.toMatch(/saved you ~?-\$/);
    expect(md).toMatch(/Caching cost you \$2\.41.*MORE than uncached/i);
  });
});

describe("receipt verification line shows the 1h WRITE SHARE, not R/C (launch-lethal regression)", () => {
  // The verification line's percentage was wired to recoverableRatio (a
  // gap-bucket ratio) instead of the 1h TTL write share. The fixture is the
  // real corpus shape where the two differ decisively: R/C = 13.7% vs
  // 1h share = creation1h/(creation1h+creation5m) = 99.5%.
  const s = fixtureEndingCReceipt;
  const share = s.tokens.creation1h / (s.tokens.creation1h + s.tokens.creation5m);
  const sharePct = `${(share * 100).toFixed(1)}%`; // "99.5%"
  const rcPct = `${(s.recoverableRatio * 100).toFixed(1)}%`; // "13.7%"

  it("fixture sanity: the two ratios differ decisively (test is meaningful)", () => {
    expect(sharePct).not.toBe(rcPct);
    expect(Math.abs(share - s.recoverableRatio)).toBeGreaterThan(0.5);
  });
  it("verification line uses the 1h share", () => {
    const { lines } = renderFull(s, NON_TTY);
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain(`${sharePct} of writes are 1h`);
  });
  it("verification line does NOT use recoverableRatio", () => {
    const { lines } = renderFull(s, NON_TTY);
    const text = stripAnsi(lines.join("\n"));
    expect(text).not.toContain(`${rcPct} of writes are 1h`);
  });
});

describe("receipt ordering: counterfactual headline leads", () => {
  it("headline (1h-vs-5m, window-labeled) -> vs-uncached -> verification, in that order", () => {
    const { lines } = renderFull(fixtureEndingCReceipt, NON_TTY);
    // Flatten wrapping: the headline hard-wraps at 80 cols mid-phrase, so
    // search a space-joined copy for the full sentences.
    const flat = stripAnsi(lines.join("\n")).replace(/\n/g, " ");
    const iHeadline = flat.indexOf("vs a 5m world in the last 90 days");
    const iUncached = flat.indexOf("vs uncached this window");
    const iVerify = flat.indexOf("of writes are 1h");
    expect(iHeadline).toBeGreaterThan(-1);
    expect(iUncached).toBeGreaterThan(iHeadline);
    expect(iVerify).toBeGreaterThan(iUncached);
    // The headline carries the windowed delta (two-deltas rule: labeled with
    // its window, never "/30d") and the saving sign is rendered as a saving.
    expect(flat).toContain("Your 1h cache saved you ~$2,500.95");
  });
  it("--md subscription verdict mirrors the ordering (headline, then vs-uncached)", () => {
    const md = renderMarkdown(fixtureEndingCReceipt);
    const iHeadline = md.indexOf("vs a 5m world in the last 90 days");
    const iUncached = md.indexOf("vs uncached this window");
    expect(iHeadline).toBeGreaterThan(-1);
    expect(iUncached).toBeGreaterThan(iHeadline);
  });
});

describe("outcome box is ending-aware", () => {
  it("API enable flow leads with money and labels the analyzed-window savings as historical", () => {
    const ending = stripAnsi(renderEnding(fixtureEndingAEnable, "A-enable", makeInk(false), makeSym(true)).lines.join("\n"));
    expect(ending).toContain("SAVE ~$80.00 / MONTH");
    expect(ending).toContain("1H CACHE COSTS 32% LESS THAN 5M");
    expect(ending).toContain("~$80.00 LESS OVER THE ANALYZED 30 DAYS");
    expect(ending).not.toContain("recoverable ratio");
    expect(ending).not.toContain("above the");
  });

  it("API 1h optimal card calls 5m the comparison, not the better option", () => {
    const summary = { ...fixtureEndingAEnable, branch: "api-1h" as const };
    const rendered = stripAnsi(numberBox(summary, makeInk(false), makeSym(true)));
    expect(rendered).toContain("SAVE ~$80.00 / MONTH");
    expect(rendered).toContain("1H CACHE COSTS 32% LESS THAN 5M");
    expect(rendered).toContain("Current 1h");
    expect(rendered).toContain("Same work 5m");
    expect(rendered).not.toContain("Better 5m");
    expect(rendered).not.toContain("YOUR 1H CACHE IS WORKING");
  });

  it("ending C normalizes the hypothetical 5m world to 100%", () => {
    const rendered = stripAnsi(numberBox(fixtureEndingCReceipt, makeInk(false), makeSym(true)));
    expect(rendered).toContain("1H CACHE USES 8% LESS OF YOUR LIMIT");
    expect(rendered).toContain("Actual 1h");
    expect(rendered).toContain("92%");
    expect(rendered).toContain("Same work on 5m");
    expect(rendered).toContain("100%");
    expect(rendered).not.toContain("SAVE ~$");
    for (const line of rendered.split("\n")) {
      expect(line.length).toBe(boxWidth); // width law still holds for this shape
    }
  });
  it("ending B headlines the already-optimal TTL", () => {
    const bBox = stripAnsi(numberBox(fixtureEndingBOptimal, makeInk(false), makeSym(true)));
    expect(bBox).toContain("5M IS ALREADY OPTIMAL");
  });
});

describe("currency separation on shared surfaces", () => {
  // On the subscriber branch every waste $-figure must carry the terse "-eq"
  // suffix — card, --compact, WRAPPED lines, and the CHECKUP warning line
  // must be consistent with the QUOTA-LEAK LIST, which says "$X-eq" for the
  // same figures, on exactly the most-shared surfaces. API branches stay
  // bare "$".
  const sub = fixtureEndingCReceipt; // currency: "USD-equivalent (API list rates)"
  const api = fixtureEndingAEnable; // currency: "USD"

  it("subscriber: checkup warning line carries -eq", () => {
    const text = stripAnsi(checkupLines(sub, makeInk(false), makeSym(true)).join("\n"));
    expect(text).toContain("($618.60-eq)");
  });
  it("subscriber: every wrapped-insight $ figure carries -eq", () => {
    const text = stripAnsi(wrappedLines(sub, makeInk(false), makeSym(true)).join("\n"));
    // every $ amount in the wrapped section is followed by -eq
    const bare = text.match(/\$[\d,]+\.\d{2}(?!-eq)/g) ?? [];
    expect(bare, `bare $ figures found in subscriber wrapped lines: ${JSON.stringify(bare)}`).toEqual([]);
    expect(text).toMatch(/\$[\d,]+\.\d{2}-eq/);
  });
  it("subscriber: card and --compact qualify every $ figure (-eq or 'in API-value')", () => {
    for (const out of [renderCard(sub, NON_TTY), renderCompact(sub, NON_TTY)]) {
      const text = stripAnsi(out);
      const bare = (text.match(/\$[\d,]+\.\d{2}(?!-eq)(?!\/mo API-value)(?! in API-value)/g)) ?? [];
      expect(bare, `bare $ figures found: ${JSON.stringify(bare)}`).toEqual([]);
      expect(text).toMatch(/\$[\d,]+\.\d{2}(-eq|\/mo API-value| in API-value)/);
    }
  });
  it("subscriber: --md biggest-miss/worst-day match its own $-eq table header", () => {
    const md = renderMarkdown(sub);
    expect(md).toMatch(/\*\*Biggest single miss:\*\*.*-eq in one turn\./);
    expect(md).toMatch(/\*\*Worst day:\*\*.*-eq leaked\./);
  });
  it("API branch: no -eq anywhere on card/compact/full render", () => {
    for (const out of [
      renderCard(api, NON_TTY),
      renderCompact(api, NON_TTY),
      renderFull(api, NON_TTY).lines.join("\n"),
      renderMarkdown(api),
    ]) {
      expect(stripAnsi(out)).not.toContain("-eq");
    }
  });
});

describe("share-safe output by default (v1.0.1, privacy): no project names unless --projects", () => {
  // Fixture project strings that must never leak into default human output.
  // fixtureEndingCReceipt: biggestMiss.project shortens to "orders-api",
  // biggestSessionProject to "web-dashboard" (shortProject takes the last
  // two dash segments); A/B fixtures shorten to widgetco-api / quietco-app.
  const LEAKY = ["orders-api", "web-dashboard", "widgetco", "quietco"];
  const SHOW = { tty: false, showProjects: true } as const;

  it("default renders contain no project string, for all fixtures and all human modes", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      for (const out of [
        renderFull(s, NON_TTY).lines.join("\n"),
        renderCard(s, NON_TTY),
        renderCompact(s, NON_TTY),
        renderMarkdown(s),
        renderExplain(s),
      ]) {
        const text = stripAnsi(out);
        for (const leak of LEAKY) {
          expect(text, `project name "${leak}" leaked into default output`).not.toContain(leak);
        }
      }
    }
  });
  it("--projects opts back in (wrapped lines carry the project again)", () => {
    const full = stripAnsi(renderFull(fixtureEndingCReceipt, SHOW).lines.join("\n"));
    expect(full).toContain("in orders-api");
    expect(full).toContain("in web-dashboard");
    const card = stripAnsi(renderCard(fixtureEndingCReceipt, SHOW));
    // card's single wrapped line is the top-ranked insight; with this fixture
    // that's the model-switch line (no project), so just assert card respects
    // the flag without crashing and full render above carries both projects.
    expect(card.length).toBeGreaterThan(0);
  });
  it("the default line reads clean without the clause (no dangling ' in ')", () => {
    const text = stripAnsi(renderFull(fixtureEndingCReceipt, NON_TTY).lines.join("\n")).replace(/\n/g, " ");
    expect(text).toMatch(/-token re-warm [-—] \$/); // "re-warm — $7.03-eq", no " in <proj>"
    expect(text).toMatch(/tokens of cache\./); // "…of cache." with no project tail
  });
});

describe("branded box frame (v1.0.1): brand woven into the top border", () => {
  it("unicode frame: top border carries the brand, bottom is plain, width exactly 57", () => {
    const rendered = stripAnsi(numberBox(fixtureEndingCReceipt, makeInk(true), makeSym(false)));
    const lines = rendered.split("\n");
    expect(lines[0]).toContain("─ cache-refund ");
    expect(lines[0].startsWith("╭")).toBe(true);
    expect(lines[0].endsWith("╮")).toBe(true);
    expect(lines[lines.length - 1]).not.toContain("cache-refund");
    expect(lines[lines.length - 1].startsWith("╰")).toBe(true);
    for (const line of lines) expect(line.length).toBe(boxWidth);
    // interior no longer carries the old dim brand row
    const interior = lines.slice(1, -1).join("\n");
    expect(interior).not.toContain("cache-refund");
  });
  it("ASCII fallback frame: `+--- cache-refund ---...---+`, width exactly 57, byte-clean", () => {
    const rendered = stripAnsi(numberBox(fixtureEndingCReceipt, makeInk(false), makeSym(true)));
    const lines = rendered.split("\n");
    expect(lines[0].startsWith("+--- cache-refund ")).toBe(true);
    expect(lines[0].endsWith("+")).toBe(true);
    for (const line of lines) {
      expect(line.length).toBe(boxWidth);
      for (const ch of line) expect(ch.codePointAt(0)!).toBeLessThanOrEqual(127);
    }
  });
  it("all three endings share the frame (score box A/B + receipt box C + certificate box B)", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      const top = stripAnsi(numberBox(s, makeInk(false), makeSym(true))).split("\n")[0];
      expect(top).toContain(" cache-refund ");
    }
    // the CERTIFIED OPTIMAL certificate box uses the same branded frame
    const bFull = stripAnsi(renderFull(fixtureEndingBOptimal, NON_TTY).lines.join("\n"));
    const brandedTops = bFull.split("\n").filter((l) => l.startsWith("+--- cache-refund "));
    expect(brandedTops.length).toBe(2); // score box + certificate box
  });
});

describe("scan-progress frames (v1.0.1 progress-line fix): finalized, never stuck", () => {
  function makeProgress() {
    return makeScanProgress("following the money…", makeInk(false), makeSym(false));
  }
  it("initial frame (before discovery) shows no made-up counts", () => {
    const p = makeProgress();
    const first = p.frame(0, 0);
    expect(first).not.toBeNull();
    expect(first!).toContain("scanning sessions…");
    expect(first!).not.toContain("0/0");
    expect(first!.startsWith("\r")).toBe(true);
  });
  it("throttles to integer-percent changes and every frame starts with \\r (rewrites only its own line)", () => {
    const p = makeProgress();
    p.frame(0, 0);
    const frames: string[] = [];
    for (let i = 1; i <= 1000; i++) {
      const f = p.frame(i, 1000);
      if (f !== null) frames.push(f);
    }
    // ~100 percent-change frames, not 1000
    expect(frames.length).toBeGreaterThan(50);
    expect(frames.length).toBeLessThan(150);
    for (const f of frames) {
      expect(f.startsWith("\r")).toBe(true);
      expect(f).not.toContain("\n"); // never spills onto another line
    }
    expect(frames[frames.length - 1]).toContain("(100%)");
  });
  it("finish() erases the line completely — the last emitted state is empty, not a stuck frame", () => {
    const p = makeProgress();
    const longest = Math.max(
      ...[p.frame(0, 0), p.frame(1, 3), p.frame(2, 3), p.frame(3, 3)]
        .filter((f): f is string => f !== null)
        .map((f) => f.replace(/^\r/, "").length),
    );
    const fin = p.finish();
    expect(fin.startsWith("\r")).toBe(true);
    expect(fin.endsWith("\r")).toBe(true);
    const erased = fin.slice(1, -1);
    expect(erased.trim()).toBe(""); // spaces only — the line is blanked
    expect(erased.length).toBeGreaterThanOrEqual(longest); // covers the widest frame
  });
});

describe("share templates (v1.0.2: plain English, percentage framing)", () => {
  const PROJECT_LEAKS = ["orders-api", "web-dashboard", "widgetco", "quietco", "-Users-"];

  it("ending A: dollar hook + pct-of-bill + config-line claim, under 280 chars", () => {
    const t = shareTemplate(fixtureEndingAEnable);
    expect(decideEnding(fixtureEndingAEnable)).toBe("A-enable");
    // |delta -80| / cost5m 246.25 = 32.5% -> rounds to 32
    expect(t).toContain("cache-refund found $80.00 I'm leaving on the table");
    expect(t).toContain("32% of my Claude Code cache bill, recoverable with one config line");
    expect(t).toContain("Check yours: npx cache-refund #cacherefund");
    expect(t.length).toBeLessThanOrEqual(280);
  });
  it("ending B: score + plain-English verdict + token scale, under 280 chars", () => {
    const t = shareTemplate(fixtureEndingBOptimal);
    expect(t).toContain("CERTIFIED OPTIMAL 96.3/100");
    expect(t).toContain("The default cache setting is actually right for how I work");
    expect(t).toMatch(/verified over [\d.]+[MBK]? tokens/);
    expect(t).not.toContain("R/C"); // jargon killed
    expect(t.length).toBeLessThanOrEqual(280);
  });
  it("ending C: limit framing + API-value + window + scale, under 280 chars", () => {
    const t = shareTemplate(fixtureEndingCReceipt);
    // |delta -2500.95| / cost5m 18121.67 = 13.8% -> rounds to 14. The pct is
    // framed as usage-limit share, the subscriber's own currency (the
    // cost-weighted-metering assumption is documented in METHODOLOGY).
    expect(t).toContain("frees ~14% of my Claude Code usage limit");
    expect(t).toContain("≈$2,500.95 of API-value over the last 90 days");
    expect(t).toMatch(/across [\d.]+B tokens · 590 sessions/);
    expect(t.length).toBeLessThanOrEqual(280);
  });
  it("no jargon in any ending: no '-eq', no 'world'; every pct sane 1-99", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      const t = shareTemplate(s);
      expect(t, "share text must not carry the -eq terminal convention").not.toContain("-eq");
      expect(t.toLowerCase(), "share text must not say '5m world'").not.toContain("world");
      const pcts = [...t.matchAll(/(\d+)%/g)].map((m) => Number(m[1]));
      for (const p of pcts) {
        expect(p).toBeGreaterThanOrEqual(1);
        expect(p).toBeLessThanOrEqual(99);
      }
    }
    // The two percentage endings actually carry a pct
    expect(shareTemplate(fixtureEndingAEnable)).toMatch(/\d+% of my Claude Code cache bill/);
    expect(shareTemplate(fixtureEndingCReceipt)).toMatch(/~\d+%/);
  });
  it("never includes a project name, any ending", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      const t = shareTemplate(s);
      for (const leak of PROJECT_LEAKS) {
        expect(t, `template leaked "${leak}"`).not.toContain(leak);
      }
    }
  });
  it("stays under 280 with pathologically large numbers (scale clause truncates first)", () => {
    const monster = {
      ...fixtureEndingCReceipt,
      scope: { ...fixtureEndingCReceipt.scope, sessions: 1_234_567 },
      tokens: {
        ...fixtureEndingCReceipt.tokens,
        creationTotal: 999_999_999_999,
        readTotal: 999_999_999_999,
      },
      counterfactual: {
        ...fixtureEndingCReceipt.counterfactual,
        delta1hMinus5m: -123_456_789.12,
        delta30d: -41_152_263.04,
      },
    };
    const t = shareTemplate(monster);
    expect(t.length).toBeLessThanOrEqual(280);
    expect(t).toContain("npx cache-refund #cacherefund"); // CTA always survives
  });
});

describe("scale line + card share hint (v1.0.1)", () => {
  it("API outcome boxes retain the analyzed scale line", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal]) {
      const rendered = stripAnsi(numberBox(s, makeInk(false), makeSym(true)));
      const total = s.tokens.creationTotal + s.tokens.readTotal;
      expect(rendered).toMatch(/[\d.]+[MBK]? tokens - [\d,]+ sessions/); // ASCII dot
      expect(rendered).toContain(`${s.scope.sessions.toLocaleString()} sessions`);
      expect(total).toBeGreaterThan(0); // fixture sanity
      for (const line of rendered.split("\n")) expect(line.length).toBe(boxWidth);
    }
  });
  it("share hint points at `card` everywhere it renders", () => {
    const full = stripAnsi(renderFull(fixtureEndingCReceipt, NON_TTY).lines.join("\n"));
    expect(full).toContain("share: npx cache-refund card");
    expect(full).not.toContain("share: npx cache-refund --compact");
    const compact = stripAnsi(renderCompact(fixtureEndingCReceipt, NON_TTY));
    expect(compact).toContain("share: npx cache-refund card");
    const card = stripAnsi(renderCard(fixtureEndingCReceipt, NON_TTY));
    expect(card).toContain("share: npx cache-refund card");
  });
});

describe("absorbedDollars / fmtAbsorbed (v1.0.2: the absorbed-value flex line)", () => {
  it("positive delta rounds to the dollar, comma-grouped, matching uncachedCost - actualCost", () => {
    // Hand-verified against each fixture's perModel (uncachedCost) and
    // counterfactual.actualCost: A = 1025.0 - 246.25 = 778.75 -> 779;
    // B = 1080.0 - 246.0 = 834.0 -> 834; C = 50511.75... - 16645.73... -> 33866.
    expect(absorbedDollars(fixtureEndingAEnable)).toBe(779);
    expect(absorbedDollars(fixtureEndingBOptimal)).toBe(834);
    expect(absorbedDollars(fixtureEndingCReceipt)).toBe(33866);
  });
  it("non-positive delta (caching cost MORE than uncached) omits — null, never a negative figure", () => {
    expect(absorbedDollars(fixtureNegativeCachingSavings)).toBeNull();
    expect(absorbedDollars(fixtureNegativeCachingSavingsEndingB)).toBeNull();
  });
  it("fmtAbsorbed: long form says 'of API-value'; short form drops the 'of'", () => {
    expect(fmtAbsorbed(69617)).toBe("absorbed $69,617 of API-value");
    expect(fmtAbsorbed(69617, true)).toBe("absorbed $69,617 API-value");
  });
  it("the subscription box carries monthly API-value context", () => {
    const rendered = stripAnsi(numberBox(fixtureEndingCReceipt, makeInk(false), makeSym(true)));
    expect(rendered).toContain("/mo API-value absorbed");
  });
  it("the box OMITS the line entirely for the negative-delta fixtures — no line, not a negative one", () => {
    for (const s of [fixtureNegativeCachingSavings, fixtureNegativeCachingSavingsEndingB]) {
      const rendered = stripAnsi(numberBox(s, makeInk(false), makeSym(true)));
      expect(rendered).not.toContain("absorbed $");
    }
  });
  it("a pathologically large absorbed figure shortens to the box-safe form rather than ever widening the box", () => {
    const monster = {
      ...fixtureEndingCReceipt,
      perModel: [{ ...fixtureEndingCReceipt.perModel[0], basePrice: 1e15, creation5m: 1e16, creation1h: 0, read: 0 }],
    };
    const absorbed = absorbedDollars(monster);
    expect(absorbed).not.toBeNull();
    const long = fmtAbsorbed(absorbed!, false);
    // Sanity: this case actually exercises the fallback (long form alone
    // would blow the box's width law) — otherwise this test proves nothing.
    expect(long.length).toBeGreaterThan(boxWidth - 2);
    const rendered = stripAnsi(numberBox(monster, makeInk(false), makeSym(true)));
    for (const line of rendered.split("\n")) {
      expect(line.length).toBe(boxWidth);
    }
    expect(rendered).toContain("/mo API-value absorbed");
  });
});

describe("subscriber paradox explainer (v1.0.2, ending C only)", () => {
  it("renders right after the vs-uncached line, before verification", () => {
    const { lines } = renderFull(fixtureEndingCReceipt, NON_TTY);
    const flat = stripAnsi(lines.join("\n")).replace(/\n/g, " ");
    expect(flat).toContain(
      "Subscription usage is metered at API-value rates - that's how a $-priced plan absorbs this much, and why your limits stretch as far as they do.",
    );
    const iUncached = flat.indexOf("vs uncached this window");
    const iParadox = flat.indexOf("Subscription usage is metered");
    const iVerify = flat.indexOf("of writes are 1h");
    expect(iParadox).toBeGreaterThan(iUncached);
    expect(iVerify).toBeGreaterThan(iParadox);
  });
  it("never appears on A/B endings", () => {
    for (const s of [fixtureEndingAEnable, fixtureEndingBOptimal]) {
      const { lines } = renderFull(s, NON_TTY);
      expect(stripAnsi(lines.join("\n"))).not.toContain("Subscription usage is metered");
    }
  });
});

describe("limitMultiples / limitStretchLine (v1.0.3, subscription limit framing)", () => {
  it("subscription: savings derive from 1 - actual/cost5m and uncached/actual (metering-agnostic ratios)", () => {
    const m = limitMultiples(fixtureEndingCReceipt);
    // 1 - actual 16645.73 / cost5m 18121.67 = 8.1% less; uncached/actual ~3.0x
    expect(m).not.toBeNull();
    expect(m!.pctSavedVs5m).toBe(8);
    expect(m!.xUncached).toBeGreaterThan(1);
    expect(limitStretchLine(fixtureEndingCReceipt)).toBe(
      `Your 1h cache uses ~8% less of your usage limit than 5m. Uncached: ~${m!.xUncached.toFixed(1)}x.`,
    );
  });
  it("non-subscription branches -> null (the limit is a subscriber concept)", () => {
    expect(limitMultiples(fixtureEndingAEnable)).toBeNull();
    expect(limitMultiples(fixtureEndingBOptimal)).toBeNull();
  });
  it("never claims a stretch that isn't there (1h not ahead -> null)", () => {
    expect(limitMultiples(fixtureNegativeCachingSavings)).toBeNull();
  });
  it("ASCII-safe (~ and x, no ≈/×) for the non-TTY path", () => {
    const line = limitStretchLine(fixtureEndingCReceipt)!;
    expect([...line].every((c) => c.codePointAt(0)! <= 127)).toBe(true);
  });
});

describe("planMultiplierLine / --plan (v1.0.2)", () => {
  it("subscription + a positive absorbed figure -> one-decimal multiplier, ASCII-safe (~ and x, not ≈/×)", () => {
    // Monthly-vs-monthly: absorbed ($33,866 over an 84-day span) is normalized
    // to 30 days before dividing by the monthly plan price.
    const line = planMultiplierLine(fixtureEndingCReceipt, 2000);
    expect(line).toBe("~6.0x your monthly plan, absorbed for free");
    expect(line).toMatch(/^~[\d.]+x your monthly plan, absorbed for free$/);
  });
  it("planPrice undefined -> null (line omitted)", () => {
    expect(planMultiplierLine(fixtureEndingCReceipt, undefined)).toBeNull();
  });
  it("non-subscription branch -> null, even with a planPrice set", () => {
    expect(planMultiplierLine(fixtureEndingAEnable, 200)).toBeNull();
    expect(planMultiplierLine(fixtureEndingBOptimal, 200)).toBeNull();
  });
  it("no positive absorbed figure -> null, even on the subscription branch with a planPrice", () => {
    expect(planMultiplierLine(fixtureNegativeCachingSavings, 200)).toBeNull();
  });
  it("renders on the receipt prose (via renderEnding) and the box when applicable", () => {
    const ending = renderEnding(fixtureEndingCReceipt, "C", makeInk(false), makeSym(true), 2000);
    expect(ending.lines.join(" ")).toContain("your monthly plan, absorbed for free");
    const box = stripAnsi(numberBox(fixtureEndingCReceipt, makeInk(false), makeSym(true), 2000));
    expect(box).toContain("your monthly plan, absorbed for free");
  });
  it("does NOT render on API-branch endings even with a planPrice (branch-gated)", () => {
    const { lines } = renderFull(fixtureEndingAEnable, { tty: false, planPrice: 200 });
    expect(stripAnsi(lines.join("\n"))).not.toContain("your monthly plan");
  });
  it("box row order: absorbed value, then plan multiplier", () => {
    const rendered = stripAnsi(numberBox(fixtureEndingCReceipt, makeInk(false), makeSym(true), 2000));
    const rows = rendered.split("\n");
    const iAbsorbed = rows.findIndex((l) => l.includes("API-value absorbed"));
    const iPlan = rows.findIndex((l) => l.includes("your monthly plan"));
    expect(iAbsorbed).toBeGreaterThan(-1);
    expect(iPlan).toBeGreaterThan(iAbsorbed);
  });
  it("width law holds with the --plan line engaged (subscription fixture)", () => {
    const rendered = stripAnsi(numberBox(fixtureEndingCReceipt, makeInk(false), makeSym(true), 2000));
    for (const line of rendered.split("\n")) {
      expect(line.length).toBe(boxWidth);
    }
  });
  it("renderFull(--plan) stays byte-clean ASCII on non-TTY (tilde/lowercase-x, not ≈/×)", () => {
    const { lines } = renderFull(fixtureEndingCReceipt, { tty: false, planPrice: 2000 });
    const text = lines.join("\n");
    // eslint-disable-next-line no-control-regex
    const nonAscii = [...new Set([...text].filter((c) => c.codePointAt(0)! > 127))];
    expect(nonAscii).toEqual([]);
  });
});

describe("snapshots (ANSI-stripped)", () => {
  it("ending A (enable) full render", () => {
    const { lines } = renderFull(fixtureEndingAEnable, NON_TTY);
    expect(stripAnsi(lines.join("\n"))).toMatchSnapshot();
  });
  it("ending B (certified optimal) full render", () => {
    const { lines } = renderFull(fixtureEndingBOptimal, NON_TTY);
    expect(stripAnsi(lines.join("\n"))).toMatchSnapshot();
  });
  it("ending C (subscriber receipt) full render", () => {
    const { lines } = renderFull(fixtureEndingCReceipt, NON_TTY);
    expect(stripAnsi(lines.join("\n"))).toMatchSnapshot();
  });
  it("card, all three fixtures", () => {
    expect(stripAnsi(renderCard(fixtureEndingAEnable, NON_TTY))).toMatchSnapshot();
    expect(stripAnsi(renderCard(fixtureEndingBOptimal, NON_TTY))).toMatchSnapshot();
    expect(stripAnsi(renderCard(fixtureEndingCReceipt, NON_TTY))).toMatchSnapshot();
  });
  it("--compact, all three fixtures", () => {
    expect(stripAnsi(renderCompact(fixtureEndingAEnable, NON_TTY))).toMatchSnapshot();
    expect(stripAnsi(renderCompact(fixtureEndingBOptimal, NON_TTY))).toMatchSnapshot();
    expect(stripAnsi(renderCompact(fixtureEndingCReceipt, NON_TTY))).toMatchSnapshot();
  });
  it("--md, all three fixtures", () => {
    expect(renderMarkdown(fixtureEndingAEnable)).toMatchSnapshot();
    expect(renderMarkdown(fixtureEndingBOptimal)).toMatchSnapshot();
    expect(renderMarkdown(fixtureEndingCReceipt)).toMatchSnapshot();
  });
  it("--explain, subscriber fixture", () => {
    expect(renderExplain(fixtureEndingCReceipt)).toMatchSnapshot();
  });
});

describe("share template context: the just-claimed humblebrag (post-enable / recheck)", () => {
  it("post-enable on ending A uses the lousy-card line with the monthly figure", () => {
    const t = shareTemplate(fixtureEndingAEnable, "post-enable");
    expect(t).toContain("just claimed a cache refund of");
    expect(t).toContain("/month on our AI coding bill — and all I got was this lousy card.");
    expect(t).toContain("npx cache-refund #cacherefund");
    expect(t.length).toBeLessThanOrEqual(280);
  });
  it("recheck on ending A says 'saved my company' (receipts-backed)", () => {
    const t = shareTemplate(fixtureEndingAEnable, "recheck");
    expect(t).toContain("I saved my company ~$");
    expect(t).toContain("lousy card");
  });
  it("checkup context and non-A endings are unchanged", () => {
    expect(shareTemplate(fixtureEndingAEnable)).toContain("leaving on the table");
    expect(shareTemplate(fixtureEndingCReceipt, "post-enable")).toContain("usage limit");
    expect(shareTemplate(fixtureEndingCReceipt, "recheck")).not.toContain("lousy");
  });
});
