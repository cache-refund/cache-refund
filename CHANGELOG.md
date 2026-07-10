# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.1] — 2026-07-10

- **Share-safe output by default** (privacy): human-facing output no longer
  prints project names anywhere; a new `--projects` flag opts back in for
  local diagnosis. `--json` (machine mode) keeps its project fields unchanged.
- **Branded, recognizable frame**: the score/receipt box weaves `cache-cash`
  into its top border (`╭─── cache-cash ───…──╮`, bright magenta on TTYs;
  `+--- cache-cash ---...---+` in ASCII/CI mode), replacing the interior
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
- Claude Code plugin/skill (`/plugin marketplace add m8t-labs/cachecash`).
- 100% local: token counts and timestamps only, no conversation content,
  no network, zero runtime dependencies.

[Unreleased]: https://github.com/m8t-labs/cachecash/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/m8t-labs/cachecash/releases/tag/v1.0.0
