import { describe, expect, it } from "vitest";
import { makeInk, makeSym, stripAnsi } from "../src/format.js";
import { numberBox } from "../src/render.js";
import { fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt } from "./fixtures/summaries.js";

describe("outcome-first numberBox", () => {
  it("headlines monthly savings for actionable API 5m users", () => {
    const text = stripAnsi(numberBox(fixtureEndingAEnable, makeInk(false), makeSym(false)));
    expect(text).toContain("SAVE ~$80.00 / MONTH");
    expect(text).toContain("1H CACHE COSTS 32% LESS THAN 5M");
    expect(text).toContain("Current 5m");
    expect(text).toContain("Same work 1h");
    expect(text).toContain("~$80.00 LESS OVER THE ANALYZED 30 DAYS");
    expect(text).not.toContain("projected over");
    expect(text).not.toContain("CACHE EFFICIENCY SCORE");
  });

  it("headlines the optimal TTL for non-actionable API users", () => {
    const text = stripAnsi(numberBox(fixtureEndingBOptimal, makeInk(false), makeSym(false)));
    expect(text).toContain("5M IS ALREADY OPTIMAL");
    expect(text).toContain("5M CACHE COSTS 28% LESS THAN 1H");
    expect(text).toContain("Current 5m");
    expect(text).toContain("Same work 1h");
  });

  it("normalizes subscription comparison to 5m=100 and says 1h uses less", () => {
    const text = stripAnsi(numberBox(fixtureEndingCReceipt, makeInk(false), makeSym(false), 2000));
    expect(text).toContain("1H CACHE USES 8% LESS OF YOUR LIMIT");
    expect(text).toContain("Actual 1h");
    expect(text).toContain("92%");
    expect(text).toContain("Same work on 5m");
    expect(text).toContain("100%");
  });
});
