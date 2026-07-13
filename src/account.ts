import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_PROFILE_AGE_MS = 30 * 86400_000;

export type AccountPlanEvidence =
  | { kind: "recognized"; name: string; monthlyUsd: number; fresh: true; evidence: string[] }
  | { kind: "subscription"; name: string; monthlyUsd: null; fresh: true; evidence: string[] }
  | { kind: "stale"; name: string; monthlyUsd: null; fresh: false; evidence: string[] }
  | { kind: "unavailable"; name: null; monthlyUsd: null; fresh: false; evidence: string[] };

interface SafeOauthAccount {
  billingType?: unknown;
  organizationType?: unknown;
  organizationRateLimitTier?: unknown;
  userRateLimitTier?: unknown;
  seatTier?: unknown;
  profileFetchedAt?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function readAccountPlan(home: string, now: Date = new Date()): AccountPlanEvidence {
  let account: SafeOauthAccount;
  try {
    const parsed = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as { oauthAccount?: SafeOauthAccount };
    account = parsed.oauthAccount ?? {};
  } catch {
    return { kind: "unavailable", name: null, monthlyUsd: null, fresh: false, evidence: ["account metadata unavailable"] };
  }

  const fetchedAt = typeof account.profileFetchedAt === "number" ? account.profileFetchedAt : null;
  const billingType = text(account.billingType);
  const organizationType = text(account.organizationType);
  const tier = text(account.organizationRateLimitTier) ?? text(account.userRateLimitTier) ?? text(account.seatTier);
  const evidence = [
    billingType ? `billing type: ${billingType}` : null,
    organizationType ? `organization type: ${organizationType}` : null,
    tier ? `rate-limit tier: ${tier}` : null,
  ].filter((value): value is string => value !== null);

  if (fetchedAt === null || now.getTime() - fetchedAt > MAX_PROFILE_AGE_MS) {
    return { kind: "stale", name: organizationType ?? "Claude subscription", monthlyUsd: null, fresh: false, evidence: [...evidence, "account metadata stale"] };
  }

  if (/max[_-]?20x/i.test(tier ?? "")) {
    return { kind: "recognized", name: "Max 20x", monthlyUsd: 200, fresh: true, evidence };
  }
  if (/max[_-]?5x/i.test(tier ?? "")) {
    return { kind: "recognized", name: "Max 5x", monthlyUsd: 100, fresh: true, evidence };
  }

  const isSubscription = /subscription/i.test(billingType ?? "") || organizationType !== null || tier !== null;
  if (isSubscription) {
    return { kind: "subscription", name: organizationType ?? "Claude subscription", monthlyUsd: null, fresh: true, evidence };
  }
  return { kind: "unavailable", name: null, monthlyUsd: null, fresh: false, evidence: ["no subscription metadata"] };
}
