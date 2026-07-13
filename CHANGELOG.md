# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] — 2026-07-13

- **Outcome-first receipts:** API users now lead with monthly dollar savings,
  while subscribers see the estimated reduction in usage-limit consumption.
  Recognized subscription plans stay on the subscription path even when local
  settings contain ambiguous provider or TTL signals.
- **Cleaner sharing flow:** the result card appears once before a raw-key action
  menu, aggregate Markdown reports are saved automatically, and LinkedIn sharing
  copies the post text while revealing the generated card image and its path.
- **Sharper share cards:** generated terminal-style images wrap usage stories,
  remove redundant footer content, and keep API-value context concise.
- **CLI ergonomics:** `--help` and `--version` now short-circuit cleanly, and the
  compiled CLI module can be imported without executing the command pipeline.
- **Project home:** repository, issue, plugin, and package metadata now point to
  `cache-refund/cache-refund` after the GitHub organization transfer.

## [1.0.5] — 2026-07-11

- **The share image is now exactly card-sized** — the square-canvas
  workaround (dark bands above and below the card) is gone; the PNG is
  cropped to content with a built-in zero-dependency PNG codec, and falls
  back to the uncropped square only if the converter's layout ever changes.

## [1.0.4] — 2026-07-10

- **The generated share image is now a faithful replica of the terminal
  card** — real screenshots won; the designed hero (giant figure, bars, CTA
  pill) is gone. Image rows are derived from the terminal renderer and
  test-enforced identical.

## [1.0.3] — 2026-07-10

- **Usage-limit framing for subscribers** (multiples, never absolutes): the
  receipt, the share card, and the prefilled post now express the 1h cache's
  effect in the subscriber's own currency — "Same work on a 5m cache: ~9%
  more of your usage limit. Uncached: ~3.0x." and "frees ~N% of my Claude
  Code usage limit". Derivation and the single stated assumption
  (cost-weighted metering) in METHODOLOGY §13; the tool still never claims a
  percentage of the undisclosed absolute limit.
- The share-accept flow pauses ~1s between "card image on your clipboard —
  Cmd+V into the post" and the browser launch, so the tip registers before
  the browser steals focus.

## [1.0.2] — 2026-07-10

- **Renamed to `cache-refund`** (previously published as a scoped package).
  Say it out loud — that's the whole product. The install line is now
  `npx cache-refund`; the installed command is `cache-refund`; the hashtag is
  `#cacherefund`. The enable prompt now reads "Claim your cache refund".
  Baseline and backup filenames follow the new name.
- **Share text in plain English**: prefilled posts now use percentage framing
  ("~14% of my cache costs, ≈$X in API-value") — no terminal jargon (`-eq`,
  "5m world") in tweets; the terminal keeps its labeled conventions.
- **Share prompt appears every run**: the "share this?" prompt no longer asks
  just once per machine — it now appears at the end of every interactive
  checkup, same as it already did after enable, after a positive recheck, and
  on `share`. Silence it with `--no-share` or env `CACHE_REFUND_NO_SHARE=1` —
  either suppresses the prompt and its hints entirely, every run.
- **Generated share image, now a square card**: accepting the share prompt
  ([x]/[b]) writes a ready-to-attach `cache-refund-card.svg` — redesigned as
  a 720×720 square (dark terminal-window card, your numbers, never project
  names, plus a cache-writes-by-re-warm-gap breakdown) — to `~/Downloads` (or
  the current directory), and converts to PNG on macOS when possible. The
  square canvas also fixes a padding bug in the macOS thumbnail conversion.
  On macOS, the PNG is then copied straight onto the clipboard — paste it
  into the post with Cmd+V, no manual attach step; Finder-reveal is now only
  the fallback when the clipboard copy isn't available.
- **Closing card**: interactive checkups now end by dealing your card — the
  share-ready block is re-printed as the final frame, so the tail of the
  terminal is the screenshot.
- **Prompt label**: `[c] copy for Slack` → `[c] copy to clipboard`.
- **Closing card leads, then the bars**: the interactive checkup's final
  screen now prints the closing card before the gap-bars breakdown
  (previously the reverse) — the terminal's last frame now reads in the same
  order as the generated share image (hero box, then the bars).
- **Share-accept ordering fix**: accepting `[x]`/`[b]` now writes the card
  image, copies it to the clipboard, and prints the "on your clipboard" tip
  *before* opening the browser. Previously the browser could open first and
  steal window focus right as the tip printed, so it scrolled by unread.
- **Absorbed-value line**: the box and the generated card both gain a line —
  `absorbed $X of API-value` — the list-rate value of what the cache kept you
  from re-paying for, shown whenever it's a positive figure.
- **Subscriber paradox, explained**: the receipt now spells out, in one
  sentence, why a flat-priced plan can absorb a far larger API-value figure
  (subscription usage is metered at API rates internally). A new
  `--plan <usd>` flag turns that into a concrete multiple —
  `~Nx your monthly plan, absorbed for free` — on the receipt, the card, and
  the generated share image.

## [1.0.1] — 2026-07-10

- **Share-safe output by default** (privacy): human-facing output no longer
  prints project names anywhere; a new `--projects` flag opts back in for
  local diagnosis. `--json` (machine mode) keeps its project fields unchanged.
- **Branded, recognizable frame**: the score/receipt box weaves `cache-refund`
  into its top border (`╭─── cache-refund ───…──╮`, bright magenta on TTYs;
  `+--- cache-refund ---...---+` in ASCII/CI mode), replacing the interior
  brand line. All three endings share the frame.
- **Progress-line fix**: the live scan counter is now a real in-place counter
  (percent-throttled) and is erased on completion — no more stuck
  "scanning 0/1 sessions (0%)" frame above the checkup.
- **Share prompt** (interactive checkup runs only, once per machine, Enter
  skips): post to X / Bluesky via your own browser with a prefilled,
  editable summary — never project names — or copy the markdown block for
  Slack. The CLI still makes zero network requests; see SECURITY.md.
  Re-offered only right after a successful `enable` and after a `recheck`
  with positive savings.
- **Scale line on the card**: the box now shows `<tokens> tokens ·
  <sessions> sessions`; the share hint now points at `card`.

## [1.0.0] — 2026-07-10

Initial public release.

- Checkup report over local Claude Code transcripts: gap-bucket analysis,
  five-cause leak attribution, cache efficiency score (`score_version: 1`),
  biggest single miss and worst day.
- Three billing-aware endings: recommender (API on the 5-minute default),
  validator (API on 1-hour), receipt (subscription — labeled `$-equivalent`).
- Symmetric, regime-aware 5m↔1h counterfactual with a bounded tail-write
  correction; parity-tested against an independent Python reference
  implementation (see [METHODOLOGY.md](./METHODOLOGY.md)).
- TTL reality check: reports the TTL you actually *received*, read from your
  transcripts' usage fields, not from settings.
- Actions: `enable` / `revert` (confirmed, backup-first settings edit),
  `verify`, `recheck` (savings receipts against a baseline saved at enable).
- Output modes: `card`, `--md`, `--compact`, `--explain`, `--json`.
- Claude Code plugin/skill (`/plugin marketplace add cache-refund/cache-refund`).
- 100% local: token counts and timestamps only, no conversation content,
  no network, zero runtime dependencies.

[Unreleased]: https://github.com/cache-refund/cache-refund/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/cache-refund/cache-refund/compare/b6cda556d6dc29bd435c8c8a2e6cfff0c9bedc51...v1.1.0
[1.0.0]: https://github.com/cache-refund/cache-refund/releases/tag/v1.0.0
