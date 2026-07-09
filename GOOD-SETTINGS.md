# Good settings for Claude Code cache economy

**This file is content, not product.** `cache-cash` the tool only ever tells you
things it *measured from your own transcripts* and priced. This page is the other
thing — general advice about cache-friendly settings — kept deliberately separate
because opinions are not the product (a locked design choice: the tool grows only
along the *measurable-waste* axis, never the opinions axis).

So everything here is **ranked by evidence level**, strongest first, and every
row points at what — if anything — `cache-cash` can actually measure for you.
Trust the rows near the top; treat the rows near the bottom as folklore.

**Evidence ladder:**

> **measured-from-your-data** > **official-doc** > **community-consensus** > **vibes**

---

## Tier 1 — measured from your data (the tool proves it for you)

These are not opinions. Run `cache-cash` and it computes the number on *your*
transcripts.

| Advice | What `cache-cash` measures | How to see it |
|---|---|---|
| **If you're API-billed and your R/C clears 39.5%, switch to the 1-hour TTL.** | Your recoverable ratio R/C vs the exact break-even, and the symmetric-counterfactual dollar delta of switching. | `npx cache-cash` (the verdict box) / `npx cache-cash --explain` |
| **Verify the TTL you actually received — don't trust the flag.** | The received-TTL split from your `ephemeral_5m/1h` usage fields over your recent window (catches silent server downgrades). | the "TTL received" header line; `npx cache-cash verify` after enabling |
| **Cut avoidable model switches mid-session.** | `model-switch` invalidation tokens and $ — every switch dumps the cache and re-writes at full markup. | the leak table row "Model-switch invalidations" |
| **Know your worst re-warm events.** | The single biggest re-warm and your worst day, by net leak $. | `npx cache-cash --compact` |

If a piece of advice can be moved into Tier 1 — computed from transcripts,
priced, and paired with a concrete fix — it belongs in the *tool*, not this page.
That is the expansion rule.

## Tier 2 — official documentation

Anthropic-documented behavior. True, but general — the tool can confirm the
*effect* on you (via the leak table), not prescribe the setting.

- **Subscribers already get the 1-hour TTL automatically.** There is nothing to
  enable; `ENABLE_PROMPT_CACHING_1H` is an API/Bedrock/Vertex/Foundry flag. (The
  tool detects your branch and shows subscribers a receipt instead of a
  recommendation.)
- **Cache reads are ~10× cheaper than fresh input; writes carry a 1.25×–2×
  markup.** Longer-lived, well-hit caches win; caches that are written far more
  than they are read can cost more than not caching at all (the tool's "caching
  saved you $X vs uncached" line will tell you honestly which side you're on).
- **The env flag only takes effect for sessions started after the change.**
  Enable, then start a fresh session, then `verify`.

## Tier 3 — community consensus

Widely repeated in the Claude Code community, plausible, not something the tool
measures. Reasonable defaults; your mileage varies.

- **Keep long-running work inside one session** rather than restarting, so the
  cache stays warm across your natural pauses (this is exactly what pushes gaps
  from the `cold` bucket into `warm`/`recoverable`).
- **Batch related tasks** so context is reused before the TTL expires, rather
  than scattering them across cold cold-starts hours apart.
- **`/compact` is not free** — a compaction rewrites the cache; do it when the
  context genuinely needs trimming, not reflexively. (The tool attributes
  `compaction-rewrite` tokens so you can see how much it costs you.)

## Tier 4 — vibes

Folklore. Stated so you recognize it as folklore. No evidence, no measurement —
included only so you can discount it when you hear it.

- "Always turn on the 1-hour TTL." → **Not for everyone.** Below 39.5% R/C it
  costs you more. Measure first.
- "Keepalive pings keep your cache alive cheaply." → API-only, ToS-gray for
  subscribers, and the break-even gap is large; a v2 simulator will price it
  properly for API users — until then, vibes.
- "A higher efficiency score is always better settings." → The score reflects
  your *usage pattern* as much as your settings; a low score can be an
  unavoidable cold-start-heavy workflow. Read the leak table, not just the score.

---

**The one rule.** The moment any advice here becomes something `cache-cash` can
compute from your transcripts, price, and pair with a concrete fix, it graduates
out of this page and into the tool. Everything that stays here stays here because
it *can't* be measured — which is exactly why it isn't the product. See
[METHODOLOGY.md](./METHODOLOGY.md) for what the tool does measure, and how.
