import { describe, expect, it } from "vitest";
import { detectBranch, ttlRealityCheck, type EnvHints } from "../src/verdict.js";
import type { TurnEvent } from "../src/types.js";

const baseHints: EnvHints = {
  enable1h: false,
  force5m: false,
  useBedrock: false,
  useVertex: false,
  hasApiKey: false,
  settingsFound: true,
};

describe("detectBranch subscription precedence", () => {
  it.each([false, true])("does not infer billing from a received 1h TTL or its flag (%s)", (enable1h) => {
    expect(detectBranch({ ...baseHints, enable1h }, "1h", true).branch).toBe("ambiguous");
  });
  it("recognized subscription metadata wins over a stray provider-less 1h flag", () => {
    const result = detectBranch(
      {
        ...baseHints,
        enable1h: true,
        accountSubscription: true,
        accountEvidence: ["recognized Max subscription"],
      },
      "1h",
      false,
    );

    expect(result.branch).toBe("subscription");
    expect(result.evidence).toContain("=> subscription (recognized local account metadata; ignoring provider-less 1h flag)");
  });

  it("an explicit API provider signal still wins over subscription metadata", () => {
    const result = detectBranch(
      { ...baseHints, enable1h: true, hasApiKey: true, accountSubscription: true },
      "1h",
      false,
    );

    expect(result.branch).toBe("api-1h");
  });

  it("configured 1h stays api-1h when recent transcripts are still receiving 5m", () => {
    const result = detectBranch(
      { ...baseHints, enable1h: true, hasApiKey: true },
      "5m",
      false,
    );

    expect(result.branch).toBe("api-1h");
    expect(result.evidence).toContain("=> API-billed, configured for 1h but receiving 5m");
  });
});

describe("ttlRealityCheck", () => {
  const event = (overrides: Partial<TurnEvent>): TurnEvent => ({
    ts: 1_000,
    model: "claude-sonnet-4-6",
    sessionKey: "session",
    isSidechain: false,
    c5: 0,
    c1: 0,
    read: 0,
    compactBoundaryBefore: false,
    project: "project",
    ...overrides,
  });

  it("ignores expected 5m sidechain writes when judging a healthy 1h parent session", () => {
    const reality = ttlRealityCheck([
      event({ c1: 1_000 }),
      event({ isSidechain: true, c5: 10_000 }),
    ], 1, 1_000);

    expect(reality.regime).toBe("1h");
    expect(reality.creation1h).toBe(1_000);
    expect(reality.creation5m).toBe(0);
  });
});
