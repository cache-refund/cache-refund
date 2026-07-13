# METHODOLOGY

How `cache-refund` turns your transcripts into a verdict, with every constant
sourced and every formula reproducible. This document describes the code as
**implemented** in [`src/costmodel.ts`](./src/costmodel.ts) and
[`src/pricing.ts`](./src/pricing.ts) — not an idealized model. Run
`npx cache-refund --explain` to see all of it with your own numbers substituted in.

- **`score_version: 1`** (printed in `--json`; the efficiency score is only
  comparable within one score version).
- Every figure is computed from **billed token counts only** — the `usage`
  fields and timestamps in your JSONL transcripts. No conversation content is
  ever read.

---

## 1. The multipliers, and where they come from

Claude's prompt cache prices three operations as multiples of a model's **base
input** price `P` ($/token):

| operation | multiplier | in code |
|---|---|---|
| 5-minute cache **write** | **1.25 × P** | `MULT_5M_WRITE = 1.25` |
| 1-hour cache **write** | **2.00 × P** | `MULT_1H_WRITE = 2.0` |
| cache **read** (hit) | **0.10 × P** | `MULT_READ = 0.1` |

These multipliers are stated on Anthropic's pricing page (the "Prompt caching"
section) and are locked build constants. Base input prices `P` per model are the
verified list rates as of **2026-07-09**, cited in the header comment of
[`src/pricing.ts`](./src/pricing.ts) against
`https://platform.claude.com/docs/en/about-claude/pricing` (e.g. Opus 4.8 =
$5/MTok ⇒ `P = 5e-6`; Fable 5 = $10/MTok; Sonnet 5 = $2/MTok intro through
2026-08-31; Haiku 4.5 = $1/MTok). Unknown model ids resolve by family fallback,
and only surface as an "unknown model" warning if they carried non-zero billable
tokens; the `<synthetic>` model is priced-neutral and excluded from that warning
because it carries no billable tokens.

**All dollars are computed per turn at that turn's own model price, then summed
— never a single blended rate.** A corpus spanning Opus, Sonnet, and Haiku is
priced correctly line by line.

## 2. Gap classes and the regime

For each usage-bearing turn we compute the **gap** to the previous turn *in the
same session* (session key = transcript-file basename + sessionId), by
timestamp:

| gap | class | |
|---|---|---|
| no previous turn | `start` | counted with cold |
| ≤ 300 s (5 min) | `warm` | cheap re-use under either TTL |
| 300 s – 3600 s (5–60 min) | `recoverable` | **the leak** — a 1h TTL keeps this cached; a 5m TTL forces a re-write |
| > 3600 s (60 min) | `cold` | a fresh cache had to be written; unavoidable |

Let `C` = all creation (cache-write) tokens, `R` = recoverable-gap creation
tokens, `R_read` = reads on recoverable-gap turns.

**Regime** = `1h` if `creation1h > creation5m` (and `> 0`), else `5m`. This is
the TTL you are *actually receiving*, read from the
`usage.cache_creation.ephemeral_{5m,1h}_input_tokens` split, not from your
settings. The header's **TTL reality check** applies the same test to just your
most recent window (min(7, `--days`)) so a silent server-side downgrade shows up
immediately.

## 3. The break-even: 39.47%

For a pure-5m usage pattern, switching to 1h is cheaper **exactly when** the
recoverable ratio clears a fixed threshold:

```
1h cheaper  ⟺  R/C  >  (MULT_1H_WRITE − MULT_5M_WRITE) / (MULT_1H_WRITE − MULT_READ)
            =  (2 − 1.25) / (2 − 0.1)
            =  0.75 / 1.9
            ≈  0.3947   (39.47%)
```

**Derivation.** Take the recoverable-bucket tokens `R`. Under 5m you pay to
*write* them: `R · 1.25P`. Under 1h you instead pay to *read* them (they're still
cached): `R · 0.1P`, but you also still had to *write* the rest of your creation,
`(C − R)`, which now costs `2P` instead of `1.25P`. Setting the 1h total below the
5m total and solving:

```
(C − R)·2P + R·0.1P   <   C·1.25P
        C·2P − R·2P + R·0.1P   <   C·1.25P
        C·0.75P   <   R·1.9P
        R/C   >   0.75 / 1.9   =   0.3947
```

That is why the verdict is a **threshold you cross**, not an estimate. In code
this is `THRESHOLD` in `src/pricing.ts`, and `aboveThreshold` in the `--json`
summary.

## 4. The symmetric counterfactual

The break-even above is the pure-5m intuition. The actual delta `cache-refund`
reports is computed by a **symmetric, regime-aware counterfactual**: it prices
what a *fully-5m world* and a *fully-1h world* would each bill on your exact
tokens, then subtracts. This is `counterfactual()` in `src/costmodel.ts`.

Notation: `w5 = 1.25P`, `w1 = 2P`, `rd = 0.1P`, per turn at that turn's `P`.

**Actual reconstruction** (ground truth, sanity-checked against the pricing
table):

```
actual = Σ  c5·w5 + c1·w1 + read·rd
```

**Counterfactual 5m** — a fully-5m world. All creation bills at `w5`. Reads are
unchanged *except* recoverable-gap reads, which a 5m TTL would have had to
re-warm — those convert read → write at `w5`:

```
cost5m += creation · w5
          + (read · w5   if gap == recoverable)
          + (read · rd   otherwise)
```

**Counterfactual 1h** — a fully-1h world. Recoverable-gap creation becomes a
**read** at `rd` *plus a bounded incremental tail write* at `w1`; all other
creation bills at `w1`; reads at `rd`:

```
cost1h += (gap == recoverable)
            ? creation · rd + tail · w1
            : creation · w1
          + read · rd
```

**delta = cost1h − cost5m** (negative ⇒ 1h is cheaper). Normalized to 30 days as
`delta30d = delta / spanDays · 30`.

### The tail-write term and its bound

Converting a recoverable re-warm into a pure read slightly over-credits 1h,
because in a real 1h world you would still occasionally pay an incremental write
as content grows. We model that as a **tail write** sized at the session's
**warm-turn median creation**, and never larger than the turn's own creation:

```
tail = min( median(warm-turn creation in this session),  creation )
```

This is the model's **one and only approximation**. It is bounded above by the
warm-median, so it is small relative to the recoverable creation it replaces
(on the author's corpus the total tail term is `$39.23` against a 5m write cost
of thousands — the parity test asserts it stays under 5% of 5m write cost).

## 5. Relationship to the oracle (the exact identity)

`cache-refund`'s TypeScript analyzer is cross-checked against an independent Python
oracle ([`tools/oracle/analyze_cache_ttl.py`](./tools/oracle/analyze_cache_ttl.py))
on the author's real corpus. **Bucket totals, token totals, turn counts, R_read,
and R/C match the oracle exactly.** The delta differs by a *named, exact
correction* — not a fudge factor.

The oracle computes a creation-only delta at one flat price:

```
oracle_delta = ((C − R)·2 + R·0.1)·P  −  C·1.25·P
```

Our symmetric model adds two terms relative to it. Non-recoverable reads appear
identically on both our `cost5m` and `cost1h` sides, so they cancel in the delta.
What remains is exactly:

```
our_delta  =  oracle_delta  +  tailTerm  −  readReconvTerm

  tailTerm       = Σ tail · 2P  over recoverable turns    (the one approximation; small, bounded)
  readReconvTerm = R_read · (1.25 − 0.1) · P              (exact; the money 1h genuinely saves — dominant, flips the sign)
```

This identity is asserted to floating-point precision in
`test/oracle-parity.test.ts`. It is the credibility story in one line: **the TS
analyzer matches the prototype exactly; the delta difference is a named
correction (a read-reconversion the oracle omits, plus one bounded tail
estimate), not a mystery.**

The dominant term is `readReconvTerm` — the reads a 1h TTL serves that a 5m TTL
would have had to re-warm. It is why, on a subscriber corpus, the naive
creation-only oracle says 1h costs *more* while the correct symmetric delta says
1h is *cheaper*: the oracle never credits the re-warm savings.

## 6. Stated approximations and their bias directions

Three modeling choices affect the delta. We state each and its direction so a
reader can see the net posture is **conservative about 1h's advantage** — the
tool understates, rather than oversells, the case for switching:

1. **Tail-write estimate** (§4): bounded above by the session warm-median, so it
   slightly *under*-credits 1h's saving on recoverable turns. **Conservative.**
2. **Cross-session warm chains ignored:** a >60 min gap in one session may have
   been kept warm by another concurrent session; we count it as cold either way.
   This *under*-counts 1h's benefit. **Conservative.**
3. **Compaction rewrites** land in the 5–60 min bucket but are cold either way;
   counting them as recoverable would *over*-count 1h's benefit — the largest
   over-count — so **compact-marked recoverable turns are excluded from the
   recoverable bucket entirely** (attributed to their own `compaction-rewrite`
   leak row instead). This kills the over-count.

Net: items (1) and (2) understate 1h; (3) is neutralized by exclusion. The tool
is biased *against* recommending a switch, never toward it.

## 7. The leak table

Each attributable cache miss is a row (`leakRows()` in `src/costmodel.ts`), with
tokens, dollars, and share of write spend. Fixed order and semantics:

| cause | dollars = | fixable? |
|---|---|---|
| `ttl-expiry-rewarm` | **net** leak: `max(0, R·w5 − (R·rd + tail·w1))` — 5m re-warm cost minus what 1h would pay | yes (switch to 1h) |
| `cold-start` | `cold·w5` | no — informational |
| `model-switch` | creation on turns where `model` ≠ previous turn's, same session, at `w5` | yes (fewer switches) |
| `compaction-rewrite` | recoverable creation on compact-marked turns, at `w5` | partly |
| `subagent-5m` | sidechain creation (always 5m even under 1h), at `w5` | no — informational |

The `ttl-expiry-rewarm` dollars are **net of the tail write**, so this row can
legitimately be `$0` when the tail exceeds the saving — that is honest, not
missing data. Compaction and subagent tokens are removed from the recoverable
bucket to avoid double-counting.

**Biggest single miss** = the one recoverable re-warm with the largest net leak
$ (timestamp, project, tokens, $). **Worst day** = the max daily total of that
net leak. Both use the same net-leak $ and both exclude compaction-marked turns.

## 8. The efficiency score (0–100), `score_version: 1`

```
score = 100 × captured / (captured + avoidable)
```

- **captured** = `Σ read · (1 − 0.1)·P` = `Σ read · 0.9P`. The realized *saving*
  of every cache hit versus re-paying full input price for those tokens.
- **avoidable** = the two *fixable* leak rows only: net `ttl-expiry-rewarm` $ +
  `model-switch` $. Cold starts and subagent overhead are excluded as unfixable.

Both terms are $-valued from billed tokens. `captured` uses `0.9P` (a hit's
saving over a full re-read); `avoidable` uses the already-tail-corrected net
leak. When the denominator is zero (no reads, no leaks) the score is `100`. This
is `efficiencyScore()` in `src/costmodel.ts`. Because people will compare scores,
the formula is versioned: a change bumps `score_version`, and a v1 score is only
ever compared to another v1 score.

## 9. "Caching saved you $X vs uncached"

The endings also show what caching saved you versus a genuinely **uncached**
world — every cache-write *and* cache-read token billed as a fresh full-price
input token. This is a linear recombination of the per-model token rollups
(computed in `render.ts`, not the analyzer — it re-derives no gap classes or leak
attribution):

```
uncachedCost = Σ over models:  (creation5m + creation1h + read) × basePrice / 1e6
savings      = uncachedCost − actualCost
```

For a write-heavy, read-light pattern this can go *negative* (the 1.25×/2× write
markup is never recouped by enough 0.1× reads); the tool prints "caching **cost**
you $X more" honestly in that case rather than a negative "saving".

## 10. Worked example (reproducible by hand)

This is a unit-tested fixture (`test/analyze.test.ts`, `basic-5m.jsonl`): one
session, Opus 4.8 (`P = 5e-6`), all writes 5-minute.

| turn | time | gap | class | creation | read |
|---|---|---|---|---|---|
| m1 | 00:00 | — | start (cold) | 1,000,000 | 0 |
| m2 | 00:02 | 120 s | warm | 400,000 | 900,000 |
| m3 | 00:20 | 1080 s | recoverable | 600,000 | 500,000 |
| m4 | 02:00 | 5400 s | cold | 300,000 | 0 |

Buckets: warm 400k, R 600k, cold 1.3M, **C 2.3M**, R_read 500k.
**R/C = 600k / 2.3M = 0.2609** (below 0.3947 ⇒ 5m still optimal here).
Session warm-median = median{400k} = 400k.

- **actual** = 2.3M·6.25e-6 + 1.4M·5e-7 = 14.375 + 0.70 = **$15.075**
  (all creation at `w5 = 6.25e-6`; the 1.4M reads at `rd = 5e-7`).
- **cost5m** = 14.375 + (900k reads · rd) + (500k recoverable reads re-warmed · w5)
  = 14.375 + 0.45 + 3.125 = **$17.95**.
- **cost1h** = m1 `1M·w1 = 10.0` + m2 `(400k·w1 = 4.0) + (900k·rd = 0.45)`
  + m3 `(600k·rd = 0.30) + (tail 400k·w1 = 4.00) + (500k read·rd = 0.25)`
  + m4 `300k·w1 = 3.0` = **$22.00**.
- **delta = cost1h − cost5m = 22.00 − 17.95 = +$4.05** → 1h costs more, correct
  for R/C 0.26 < 0.3947.
- **ttl-rewarm net leak** = `600k·w5 − (600k·rd + tail 400k·w1)`
  = 3.75 − (0.30 + 4.00) = −0.55 → `max(0, ·)` = **$0** (the tail exceeds the
  saving on this tiny fixture).
- **cold-start leak** = `1.3M·w5` = **$8.125**.

The **sign-flip** case is the `regime-1h.jsonl` fixture (the subscriber shape):
a recoverable turn served as a pure read (creation 0, read 1.2M) gives
cost5m $17.275 vs cost1h $16.00 ⇒ **delta −$1.275**, i.e. 1h cheaper. That is the
shape of the author's real corpus, where the symmetric delta is **−$2,517.98**
(1h cheaper) over 84.3 analyzed days while the naive creation-only oracle would
have reported 1h as *more* expensive.

## 11. Two delta fields — do not mix them

`--json` exposes both, and conflating them is how a wrong-number argument starts:

- **`counterfactual.delta1hMinus5m`** — the delta over the **analyzed window**
  (e.g. "saved ~$2,517.98 vs 5m in the last 90 days"). This is what the receipt
  headline and the card show, always labeled with its window.
- **`counterfactual.delta30d`** — the same delta **normalized to a rolling 30
  days** (`delta / spanDays · 30`, here −$895.84 over an 84.3-day span). This is
  what the recommendation line uses ("saves ~$X per 30d").

The receipt/card figure is **never** labeled "/30d"; the "/30d" label belongs
only to `delta30d`.

## 12. Independent confirmations

- **Official docs.** The multipliers and the "subscribers get 1h automatically /
  `ENABLE_PROMPT_CACHING_1H` is API-only" branch rules are Anthropic's
  documented behavior (`code.claude.com/docs/en/prompt-caching`,
  `platform.claude.com` pricing).
- **Response-header cross-check.** The received-TTL split is independently
  observable in API response headers, matching the `ephemeral_{5m,1h}`
  transcript fields the reality check reads.
- **Threshold-over-simulation, empirically.** Community backtests of modeled
  cache strategies against real billed tokens have shown simple threshold
  policies beating fitted models on bursty human arrival patterns — in one such
  backtest, six modeled strategies all lost to a one-line heuristic.
  `cache-refund` ships the threshold (39.47%) and defers the full simulator to v2
  for exactly this reason.
- **Published pricing, re-derived.** The per-TTL write multipliers (1.25× / 2×)
  and the 0.1× read rate come from Anthropic's published pricing tables and are
  re-derived per model in `src/pricing.ts` (URL + retrieval date cited there).

## 13. Limit framing on the subscription branch (multiples, never absolutes)

Subscribers don't pay per token — their currency is the usage limit. The limit
formula itself is undisclosed, so `cache-refund` never claims an absolute
("you saved 9% of your weekly limit"). What it does claim is a **ratio of your
own metered usage**, which needs exactly one assumption — the same one the
receipt already states: *subscription usage is metered cost-weighted at
API-value rates.* Under that assumption, X× the cost-weighted usage is X× the
limit consumed, whatever the limit actually is:

```
1h savings vs 5m    = 1 - actual / cost5m   (e.g. 0.08 -> "~8% less of your usage limit")
uncached multiple   = uncached / actual     (e.g. 3.0  -> "~3.0x")
```

Both numerators are the same counterfactuals derived in §4; `actual` is the
ground-truth reconstruction. The line renders only on the subscription branch
and only when the 1h cache is genuinely ahead (`limitMultiples` in
`src/render.ts` returns null otherwise — the tool never claims a stretch that
isn't there). This is also how a $-priced plan "absorbs" tens of thousands of
dollars of API-value: the plan meters your usage in that currency; it doesn't
bill it.

The terminal card normalizes the hypothetical 5m world to **100%** and shows
actual 1h usage below it (for example, 92%). Its headline is therefore phrased
as "1h cache uses 8% less of your limit," not as a claim about the user's
undisclosed absolute weekly allowance.

## 14. Local account-plan evidence

Branch detection can use Claude Code's local `~/.claude.json` account cache as
an additional subscription signal. The reader allowlists only billing and tier
fields (`billingType`, organization/user rate-limit tier, organization type,
seat tier, and profile timestamp). It never reads or persists name, email,
user/account IDs, or organization IDs. Recognized Max 5x/20x tiers may add plan
framing; stale or unknown tiers remain price-free, and explicit API-provider
signals still take precedence.

## 15. Aggregate report artifacts

Every successful analysis attempts an owner-only atomic Markdown write under
`~/.claude/cache-refund/reports/`. The file contains the same content-safe
aggregates as the CLI's Markdown output: token counts, timestamps, TTL evidence,
counterfactuals, and leak rows. A report-write failure warns but does not change
the analysis verdict.

## 16. "Backtested against N weeks of real usage"

Every number `cache-refund` prints is computed over **your own real transcripts**
for the selected window — there is no synthetic model of your behavior. The
author's launch figures are computed over **590 sessions / 43,783 turns spanning
84 days** of real Claude Code usage. The oracle cross-check (bucket-exact,
delta-exact-to-a-named-correction), the golden unit fixtures, and a
hand-re-derivation of every number in the launch screenshot are the trust
surface. Every claim in a checkup is traceable: **`npx cache-refund --explain`
prints the formula with your inputs, and this document derives every constant.**
