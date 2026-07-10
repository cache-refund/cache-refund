# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
