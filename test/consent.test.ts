import { describe, expect, it } from "vitest";
import { parseConfirmation } from "../src/consent.js";

describe("parseConfirmation", () => {
  it("accepts Enter for a default-yes prompt", () => {
    expect(parseConfirmation("", true)).toBe(true);
  });

  it("rejects Enter for a default-no prompt", () => {
    expect(parseConfirmation("", false)).toBe(false);
  });

  it("honors explicit yes and no answers regardless of the default", () => {
    expect(parseConfirmation("yes", false)).toBe(true);
    expect(parseConfirmation("Y", false)).toBe(true);
    expect(parseConfirmation("no", true)).toBe(false);
    expect(parseConfirmation("N", true)).toBe(false);
  });

  it("falls back to the configured default for unrecognized input", () => {
    expect(parseConfirmation("maybe", true)).toBe(true);
    expect(parseConfirmation("maybe", false)).toBe(false);
  });
});
