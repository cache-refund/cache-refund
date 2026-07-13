import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAccountPlan } from "../src/account.js";

function homeWithAccount(oauthAccount: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "cache-refund-account-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount }), "utf8");
  return home;
}

describe("readAccountPlan", () => {
  const now = new Date("2026-07-13T12:00:00.000Z");

  it("recognizes Max 20x without returning identity fields", () => {
    const home = homeWithAccount({
      billingType: "stripe_subscription",
      organizationType: "claude_max",
      organizationRateLimitTier: "default_claude_max_20x",
      profileFetchedAt: now.getTime() - 60_000,
      displayName: "Private Name",
      emailAddress: "private@example.com",
      accountUuid: "secret",
    });

    const result = readAccountPlan(home, now);
    expect(result.kind).toBe("recognized");
    if (result.kind !== "recognized") throw new Error("expected recognized plan");
    expect(result.name).toBe("Max 20x");
    expect(result.monthlyUsd).toBe(200);
    expect(JSON.stringify(result)).not.toContain("Private Name");
    expect(JSON.stringify(result)).not.toContain("private@example.com");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("recognizes Max 5x", () => {
    const home = homeWithAccount({
      billingType: "stripe_subscription",
      organizationType: "claude_max",
      organizationRateLimitTier: "default_claude_max_5x",
      profileFetchedAt: now.getTime(),
    });
    expect(readAccountPlan(home, now)).toMatchObject({ kind: "recognized", name: "Max 5x", monthlyUsd: 100 });
  });

  it("keeps unknown subscription tiers price-free", () => {
    const home = homeWithAccount({
      billingType: "stripe_subscription",
      organizationType: "enterprise",
      seatTier: "enterprise_custom",
      profileFetchedAt: now.getTime(),
    });
    expect(readAccountPlan(home, now)).toMatchObject({ kind: "subscription", monthlyUsd: null });
  });

  it("marks old cached metadata stale", () => {
    const home = homeWithAccount({
      billingType: "stripe_subscription",
      organizationType: "claude_max",
      organizationRateLimitTier: "default_claude_max_20x",
      profileFetchedAt: now.getTime() - 45 * 86400_000,
    });
    expect(readAccountPlan(home, now)).toMatchObject({ kind: "stale", monthlyUsd: null });
  });

  it("returns unavailable for missing or malformed metadata", () => {
    const home = mkdtempSync(join(tmpdir(), "cache-refund-account-"));
    expect(readAccountPlan(home, now).kind).toBe("unavailable");
    writeFileSync(join(home, ".claude.json"), "{bad", "utf8");
    expect(readAccountPlan(home, now).kind).toBe("unavailable");
  });
});
