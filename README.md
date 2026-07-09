# cache-cash

[![CI](https://github.com/m8t-labs/cachecash/actions/workflows/ci.yml/badge.svg)](https://github.com/m8t-labs/cachecash/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/cache-cash.svg)](https://www.npmjs.com/package/cache-cash)

**Finds the money your Claude Code cache is leaking.**

One `npx` run reads your local Claude Code transcripts, computes what the prompt
cache saved you and what it *leaked* — attributed to specific causes — and, for
API-billed users still on the 5-minute default, tells you whether the 1-hour
cache TTL would save you money and enables it with one confirmation.

```
+-------------------------------------------------------+
|                      cache-cash                       |
|                                                       |
|                 YOUR 1H CACHE RECEIPT                 |
|         saved ~$2,506.47-eq vs 5m (last 90d)          |
|                                                       |
|             efficiency score: 98.5 / 100              |
+-------------------------------------------------------+

  > Model switches invalidated 70.3M tokens of cache ($513.86).

share: npx cache-cash --compact  -  #cachecash
```

<sub>`npx cache-cash card` on the author's real 590-session corpus (subscription branch — a subscriber's cache is already on 1h, so this is a receipt, not a recommendation). On a real terminal the box is drawn with Unicode; the ASCII form above is what pastes cleanly into a code block. Your numbers are your own.</sub>

```bash
npx cache-cash
```

No install, no account, no config. Node 18+.

> **100% local.** Reads token counts and timestamps only. No conversation content. No network.

That is the whole security model. `cache-cash` opens the JSONL transcripts under
`~/.claude/projects`, reads the `usage` token counts and the timestamps, and does
arithmetic. It never reads your prompts or Claude's replies, never phones home,
and has zero runtime dependencies (the entire tool is one `tsc`-compiled
zero-dependency TypeScript CLI — nothing to audit but the code itself).

---

## How it works (three sentences)

Every cache-write in your transcripts is a token you paid a **markup** to store
(1.25× base input on the 5-minute TTL, 2× on the 1-hour TTL). `cache-cash`
classifies each write by the **gap since the previous turn in that session** —
if the gap fits inside the TTL the write was cheap re-use, if it fell just
outside the TTL window (5–60 min) it was an avoidable *re-warm*, and if it was a
cold session start it was unavoidable. It then prices a **symmetric
counterfactual** — what a fully-5m world and a fully-1h world would each have
billed on *your* tokens — so the verdict is a threshold you cross, not a guess.

| gap since previous turn | bucket | meaning |
|---|---|---|
| session start, or > 60 min | **cold** | unavoidable — a fresh cache had to be written. Informational. |
| 5–60 min | **recoverable** | the leak. A 1-hour TTL would still have this cached; a 5-minute TTL made you pay to write it again. |
| ≤ 5 min | **warm** | cheap re-use — cached under either TTL. |

The one number that decides the recommendation is **R/C** — the share of your
cache-write tokens that fell in the recoverable bucket. Above **39.5%**, the
1-hour TTL is cheaper for your pattern; below it, the 5-minute default already
wins. (That 39.5% is not a vibe — it is `(2 − 1.25) / (2 − 0.1)`, derived in
[METHODOLOGY.md](./METHODOLOGY.md).)

Everything above is computed only from billed token counts. Run `npx cache-cash
--explain` to see every formula with *your* numbers substituted in.

## What you get — three endings, one per billing model

`cache-cash` auto-detects how you pay (from your settings env flags, provider
hints, and the observed cache regime in your transcripts) and renders one of
three endings:

- **API-billed, on the 5-minute default → the recommender.** Gap table + your
  R/C vs the 39.5% break-even + the counterfactual delta ("switching to 1h saves
  ~$X per 30 days", or "5m is already optimal for you — 1h would cost $Y more").
  If 1h wins, it offers to enable it: `Enable 1h now? [y/N]`.
- **API-billed, already on 1h → the validator.** "Keeping 1h saves ~$X vs 5m",
  or, if your pattern actually favors 5m, "revert — 5m is cheaper for you", with
  a confirmed revert flow.
- **Subscription → the receipt.** Subscribers get the 1-hour TTL automatically,
  so there is nothing to enable. Instead you get a receipt: "your 1h cache saved
  you ~$X-equivalent vs a 5m world", a leak table ranked by quota impact, and
  your Cache Wrapped. (Subscriber dollars are labeled **"$-equivalent (API list
  rates)"** — the subscription limit formula is undisclosed, so we never tell a
  subscriber they "saved $"; see the FAQ.)

Below the break-even, you get a **"Certified optimal"** card instead of a nag —
that is also a screenshot worth sharing.

## The fix, and how to trust it

For an API user whom the math tells to switch:

```bash
npx cache-cash enable     # adds ENABLE_PROMPT_CACHING_1H=1 to ~/.claude/settings.json
```

This is the **only** thing `cache-cash` ever writes, it asks first (unless you
pass `--yes`), it backs up `settings.json` before touching it, and it preserves
every other key. `npx cache-cash revert` undoes it.

The env flag only applies to **sessions started after the change**, and Claude
Code has had intermittent flakiness landing it
([anthropics/claude-code#49139](https://github.com/anthropics/claude-code/issues/49139)),
so the tool verifies itself rather than asking you to trust it:

```bash
npx cache-cash verify     # after a few turns in a fresh session
```

`verify` re-reads your *newest* transcripts and checks the **TTL reality check**
— the TTL you are *actually receiving* per your last few days of usage, read
straight from the `ephemeral_5m`/`ephemeral_1h` usage fields, not from what
`settings.json` claims. If 1h landed, it says so. Later:

```bash
npx cache-cash recheck    # the comeback loop
```

`recheck` compares against a small baseline saved at enable time and shows
"since switching: $X saved". No external tools at any step — the product
verifies the product.

## Why the TTL reality check exists (a cautionary tale)

In March 2026 the Claude API server-side **silently downgraded** some 1-hour
cache writes to 5-minute for a stretch — settings said 1h, transcripts billed
5m. Anyone reasoning from their *config* rather than their *transcripts* was
quietly wrong for weeks.

The sharpest illustration we know of: a serious community effort once modeled
cache-keepalive strategies against an *assumed* TTL. When the models were
finally checked against real billed tokens, **six carefully-modeled strategies
all lost to a one-line heuristic** — and part of the modeling had rested on a
TTL that the server wasn't actually honoring. The lesson `cache-cash`
takes from that story: **measure the TTL you received, don't trust the one you set.**
That is why every checkup leads with the reality-check line, and why the
regression *watchdog* (below) is the roadmap's flagship.

## Other output modes

```bash
npx cache-cash card       # the canonical screenshot: section box + top Wrapped line
npx cache-cash --md       # paste-ready markdown block for Slack / Teams
npx cache-cash --compact  # ~7 lines: score, R/C verdict, biggest miss, worst day
npx cache-cash --json     # full machine-readable summary (stable schema, never prompts)
npx cache-cash --explain  # every formula, your numbers substituted (METHODOLOGY, one flag away)
```

Flags: `--days N` (default 90) · `--project <path>` (default: all projects) ·
`--price <model=$/MTok,...>` (override pricing) · `--yes` / `-y` (skip confirm) ·
`--no-color` · `--all-time`. Exit codes: `0` ok · `1` no transcripts found ·
`2` parse/internal error.

## FAQ

**I'm on a subscription (Pro/Max) — is there anything to do?**
No action, but there is a receipt. Subscribers already get the 1-hour TTL
automatically; `cache-cash` shows you what it saved you and where your quota is
still leaking (model switches, cold starts). Dollar figures are labeled
`$-equivalent (API list rates)` because the subscription quota formula is
undisclosed — we price your tokens at API list rates so the number is *anchored
and reproducible*, but it is not a bill.

**Does it work on Bedrock / Vertex?**
Yes. `ENABLE_PROMPT_CACHING_1H` is an API/Bedrock/Vertex/Foundry feature, so the
enable recommendation applies to all of them. The analyzer reads the same
transcript format regardless of provider.

**Is the efficiency score comparable between people?**
Only within a `score_version`. This is `score_version: 1` (printed in `--json`
and in [METHODOLOGY.md](./METHODOLOGY.md)). The formula is fully documented; if
it ever changes, the version bumps, so a v1 score is only ever compared to
another v1 score.

**A leak row says $0.00 — is that a bug?**
Almost certainly not. Subagent-5m overhead is $0 if you ran no sidechains in the
window; compaction rewrites are near-$0 if you rarely `/compact`; and the
recoverable-leak dollars are *net* of what a 1h TTL would itself cost, so a row
can legitimately be $0 when the tail write cancels the saving. Zero rows are
honest, not missing data.

**I think a number is wrong.**
That is the highest-priority kind of bug report. Open a
[wrong-number issue](https://github.com/m8t-labs/cachecash/issues/new?template=wrong-number.yml)
— it asks for your `--json` and `--explain` output (token counts and timestamps
only, no content) so the exact figure can be reproduced and traced through the
formula.

## Roadmap

- **v1.1 — the TTL regression watchdog.** A `watch` mode that alarms the moment
  your received TTL flips (the March-2026 incident, turned into a live tripwire).
  Plus `card --html` (a self-contained dark-mode card for LinkedIn/decks) and
  sleep-window learning to split cold gaps into "asleep" vs "abandoned".
  `watch` is teased in the checkup footer as *coming* — it is not a shipped
  command yet.
- **v1.5 — `team`** aggregate mode (v1 already ships `--json` + a documented `jq`
  merge for fleets).
- **v2 — a policy simulator** behind the same cost model: price
  `5m+keepalive` and `1h+keepalive` for API users.

The roadmap has one rule (see [METHODOLOGY.md](./METHODOLOGY.md) and
[GOOD-SETTINGS.md](./GOOD-SETTINGS.md)): every new check must be *computed from
your transcripts, priced, and paired with one concrete fix.* Generic
settings-opinion tips are never product.

## Relationship to spend dashboards

Spend dashboards report what you **spent**. `cache-cash` reports what you
**wasted, why, and the fix** — it is the decision, not the dashboard. They
compose: watch your spend wherever you already watch it, then run `cache-cash`
when you want to know whether the cache defaults are costing you and what to
change. (The per-TTL write pricing here comes from Anthropic's published
per-model rates, re-derived in [METHODOLOGY.md](./METHODOLOGY.md) with the
retrieval date cited in `src/pricing.ts`.)

## Contributing & license

Wrong-number reports get a priority lane — see
[CONTRIBUTING.md](./CONTRIBUTING.md). MIT licensed, © 2026 Ilan Bar-Magen.

Methodology in full: [METHODOLOGY.md](./METHODOLOGY.md) · or run `npx cache-cash --explain`.
