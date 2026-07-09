---
name: cache-cash
description: >-
  Analyze this machine's Claude Code prompt-cache economy and report what the
  cache saved, what it leaked (attributed to causes), and — for API-billed users
  on the 5-minute default — whether enabling the 1-hour cache TTL would save
  money. Use when the user asks about their Claude Code cache cost, prompt-cache
  savings or waste, cache efficiency, the 1-hour vs 5-minute TTL, whether to set
  ENABLE_PROMPT_CACHING_1H, "am I leaking money on cache", "run cache-cash", or
  "is my cache TTL costing me". 100% local — reads token counts and timestamps
  only, never conversation content, no network.
allowed-tools: Bash(npx @m8t-labs/cache-cash*)
---

# cache-cash — cache-doctor checkup

You are running the `cache-cash` checkup for the user and narrating it
conversationally. `cache-cash` is a zero-dependency local CLI that reads Claude
Code transcripts under `~/.claude/projects`, reads **only** the `usage` token
counts and timestamps (never prompt/response content, no network), and computes
what the prompt cache saved and leaked.

## Step 1 — run the analyzer (machine-readable)

Run:

```bash
npx @m8t-labs/cache-cash --json
```

This prints a stable JSON summary and **never prompts**. Parse it. If it exits
non-zero or prints no JSON: exit code `1` = no transcripts found under
`~/.claude/projects` (tell the user there's nothing to analyze yet); `2` =
parse/internal error (suggest `npx @m8t-labs/cache-cash` directly and, if it reproduces, a
bug report at https://github.com/m8t-labs/cachecash/issues).

The fields you'll use:

- `branch` — `"subscription"`, `"api-5m"`, `"api-1h"`, or `"ambiguous"`.
- `currency` — `"USD"` for API branches, `"USD-equivalent (API list rates)"` for
  subscription. **Use this string verbatim in every dollar figure.** Never tell a
  subscriber they "saved $" — say "$-equivalent (API list rates)".
- `counterfactual.delta1hMinus5m` — the 1h-vs-5m delta over the analyzed window
  (negative = 1h is cheaper). This is **the number**.
- `window.days`, `scope.sessions`, `scope.turns` — the framing.
- `recoverableRatio` and `threshold` — R/C vs the 39.5% break-even.
- `efficiencyScore` (with `scoreVersion`) — 0–100.
- `leaks[]` — five rows (`ttl-expiry-rewarm`, `cold-start`, `model-switch`,
  `compaction-rewrite`, `subagent-5m`), each with `tokens`, `dollars`,
  `informational`.
- `ttlRealityCheck.received` — the TTL actually landing in recent transcripts.
- `biggestMiss`, `worstDay`, `wrapped` — the visceral share stats.

## Step 2 — narrate "the number" in ONE sentence, with the verbatim figure

Lead with a single sentence carrying the exact dollar figure from the JSON,
rounded as printed, labeled with `currency` and the window. Do not round further
or restate it in your own units. Shape by branch:

- **subscription:** "Your 1h cache saved you ~$`{abs(delta1hMinus5m)}` `{currency}`
  vs a 5m world over the last `{window.days}` days (across `{scope.sessions}`
  sessions)." (1h is auto-active for subscribers — this is a receipt, not a
  recommendation.)
- **api-5m, delta negative (1h cheaper):** "Switching to the 1-hour cache TTL
  would save you ~$`{abs(delta1hMinus5m)}` `{currency}` over the last
  `{window.days}` days."
- **api-5m, delta ≥ 0:** "You're already optimal — the 5-minute default is
  cheaper for your pattern; 1h would cost ~$`{delta1hMinus5m}` more."
- **api-1h:** "Keeping the 1-hour TTL saves you ~$`{abs(delta1hMinus5m)}`
  `{currency}` vs 5m" (or, if delta ≥ 0, that reverting to 5m would be cheaper).
- **ambiguous:** say you couldn't auto-detect their billing (subscription vs
  API/Bedrock/Vertex) and ask which it is, then re-run `npx @m8t-labs/cache-cash` (the
  interactive checkup resolves it).

## Step 3 — show the gap breakdown in plain words

Explain, briefly, where the cache-write tokens fell (from `buckets` /
`leaks[]`), in prose the user can act on:

- **recoverable / TTL-expiry re-warms** (`ttl-expiry-rewarm`): writes that landed
  5–60 min after the previous turn — a 1-hour TTL keeps these cached; a 5-minute
  TTL made them pay twice. Give tokens + `dollars`. This is the fixable leak.
- **model-switch invalidations** (`model-switch`): switching model mid-session
  dumps the cache; give tokens + `dollars`. Also fixable (fewer switches).
- **cold starts** (`cold-start`, `informational:true`): fresh sessions / >60 min
  gaps — unavoidable. Mention but label as not-fixable.
- Note any `$0.00` rows are honest (e.g. no sidechains ⇒ subagent-5m is $0), not
  missing data.
- Drop in the visceral stat: `biggestMiss` ("a `{tokens}`-token re-warm cost
  $`{dollars}` in one turn") and/or `worstDay`.

State the verdict from `recoverableRatio` vs `threshold`: above 39.5% ⇒ 1h wins;
below ⇒ 5m is already optimal.

## Step 4 — offer the fix, but DO NOT edit settings yourself

**You never write to `~/.claude/settings.json` or set any env flag yourself.**
The tool owns the only write path, with backup + confirmation. If (and only if)
`branch` is `api-5m` and `delta1hMinus5m` is negative (1h is cheaper), offer:

> "Want to enable the 1-hour TTL? Run `npx @m8t-labs/cache-cash enable` — it backs up your
> settings, adds `ENABLE_PROMPT_CACHING_1H=1`, and asks before writing. Then
> start a fresh session and run `npx @m8t-labs/cache-cash verify` to confirm 1h actually
> landed."

For `api-1h` where 5m would be cheaper, point to `npx @m8t-labs/cache-cash revert` the same
way. For `subscription`, there is nothing to enable — say so.

Do not run `enable`/`revert` on the user's behalf. Surface the command and let
the user run it. (If they explicitly ask you to run it, run `npx @m8t-labs/cache-cash
enable` — the tool's own confirmation prompt is the safeguard — but never edit
the settings file directly.)

## Step 5 — share rail + star ask

Close with, briefly:

- "Screenshot-friendly version: `npx @m8t-labs/cache-cash card`. Full receipt: just
  `npx @m8t-labs/cache-cash`."
- "Every number is traceable — `npx @m8t-labs/cache-cash --explain` shows each formula with
  your inputs."
- "If it's useful, a star helps: https://github.com/m8t-labs/cachecash — and share
  your score with #cachecash."

## Guardrails

- 100% local. You are only ever running `npx @m8t-labs/cache-cash …`. Never read transcript
  content, never make network calls, never edit settings files directly.
- Quote the figures from `--json` **verbatim** (as printed). If the user disputes
  a number, have them run `npx @m8t-labs/cache-cash --explain` (the derivation) and file a
  wrong-number report — don't re-derive it yourself.
- Respect `currency`: subscribers get "$-equivalent (API list rates)", never
  "saved $".
