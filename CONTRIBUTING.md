# Contributing to cache-refund

Thanks for helping. This is a small, deliberately-scoped tool; the bar for
changes is "does it make a number more correct, more honest, or more useful."

## Wrong-number reports are the priority lane

A wrong number in public is the worst thing that can happen to a tool whose
entire pitch is "trust this math." So **a report that `cache-refund` printed a
figure that doesn't match reality jumps the queue.** Open a
[wrong-number issue](https://github.com/m8t-labs/cache-refund/issues/new?template=wrong-number.yml);
it asks for your `--json` and `--explain` output so the exact figure can be
reproduced and traced through the formula. Those outputs contain **token counts
and timestamps only — no conversation content** (that is the whole privacy model;
see the README). If reproducing it needs a transcript shape we don't have, we'll
ask for a minimal *synthetic* fixture, never your real prompts.

## Dev setup

```bash
git clone https://github.com/m8t-labs/cache-refund
cd cache-refund
npm install          # devDependencies only — see the zero-dep rule below
npm run build        # tsc -> dist/
npm test             # vitest: unit math + render snapshots + oracle parity
node dist/cli.js     # run the CLI against your own corpus
```

Requires Node 18+. The oracle-parity test cross-checks the analyzer against the
Python prototype in `tools/oracle/` on your real `~/.claude/projects` corpus; it
**auto-skips** if that corpus (or `python3`) is absent, so a fresh clone on a
machine with no Claude Code history still goes green on the rest of the suite.

## The zero-dependency rule (non-negotiable)

`cache-refund` ships with **zero runtime `dependencies`**. The npx cold-start is
the first impression, and "no dependencies to audit" is a trust line for a tool
that reads your `~/.claude` directory. Only these `devDependencies` are allowed:
`typescript`, `vitest`, `@types/node`. A PR that adds a runtime dependency will
be declined on principle — if you need a helper, inline it or use the Node
standard library.

## What changes are in scope

- **In scope:** correctness of the math, new *measurable-waste* checks (each must
  be computed from transcripts, priced, and paired with one concrete fix — see
  the expansion rule in [METHODOLOGY.md](./METHODOLOGY.md) and
  [GOOD-SETTINGS.md](./GOOD-SETTINGS.md)), render/output polish, more model ids in
  the pricing table (cite the source), portability fixes.
- **Out of scope:** generic settings-opinion features (that's `GOOD-SETTINGS.md`,
  which is content, not product), anything that reads conversation content, or
  anything that adds a network call. Disk writes are limited to confirmed
  settings edits, the enable baseline, aggregate Markdown reports under
  `~/.claude/cache-refund/reports/`, and explicitly requested/generated card files.

## Previewing the other endings

A given corpus only ever shows one of the three endings (recommender,
validator, receipt) — the one your real detected branch earns. When a change
touches rendering and you want to see all three without three different
machines, force the branch with the hidden dev flag:

```bash
node dist/cli.js --branch-override api-5m       # the recommender ("enable 1h")
node dist/cli.js --branch-override api-1h       # the validator ("keep 1h" / "revert")
node dist/cli.js --branch-override subscription # the receipt
```

This re-runs the verdict logic for the forced branch on your **real**
transcript numbers — buckets, costs, and leaks are still yours, only the
billing-branch assumption (and therefore the ending) changes. The evidence
trail says so plainly (`=> branch override (--branch-override)`), never
claiming you answered the interactive branch question. It's a maintainer/QA
tool for screenshots and rendering QA, not a supported flag — it isn't
documented in the README.

## Working style

- Match the existing TypeScript: strict, ESM, no runtime deps.
- If you touch the analyzer, keep the oracle-parity test green — it is the
  launch-blocking trust test. If you change a formula on purpose, update
  [METHODOLOGY.md](./METHODOLOGY.md) in the same PR and bump `score_version` if
  the efficiency score changed.
- Any change to terminal rendering must keep the non-TTY / `CI=1` output
  byte-clean 7-bit ASCII and the card box at its fixed width — there are
  regression tests that enforce both.

MIT licensed, © 2026 Ilan Bar-Magen.
