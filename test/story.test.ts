import { describe, expect, it } from "vitest";
import { usagePatternStory } from "../src/story.js";
import { fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt } from "./fixtures/summaries.js";

describe("usagePatternStory", () => {
  it("describes synthetic sustained deep-session usage", () => {
    const summary = {
      ...fixtureEndingAEnable,
      scope: { ...fixtureEndingAEnable.scope, sessions: 47, turns: 5_734 },
      recoverableRatio: 0.52,
      wrapped: { ...fixtureEndingAEnable.wrapped, biggestSessionCreation: 14_900_000, peakHourTurns: 943 },
    };
    const story = usagePatternStory(summary);
    expect(story.kind).toBe("deep-sessions");
    expect(story.text).toContain("deep, sustained sessions");
    expect(story.text).toContain("return after short breaks");
  });

  it("describes synthetic many-short-session usage separately from deep sessions", () => {
    const summary = {
      ...fixtureEndingAEnable,
      scope: { ...fixtureEndingAEnable.scope, sessions: 1_247, turns: 16_086 },
      recoverableRatio: 0.33,
      wrapped: { ...fixtureEndingAEnable.wrapped, biggestSessionCreation: 61_700_000, peakHourTurns: 982 },
    };
    const story = usagePatternStory(summary);
    expect(story.kind).toBe("many-sessions");
    expect(story.text).toContain("many shorter sessions");
  });

  it("describes high-volume long-running recoverable work", () => {
    const story = usagePatternStory(fixtureEndingCReceipt);
    expect(story.kind).toBe("long-running");
    expect(story.text).toContain("long-running sessions");
    expect(story.text).toContain("5–60 minutes");
  });

  it("describes deep sessions when turns per session are very high", () => {
    const story = usagePatternStory(fixtureEndingAEnable);
    expect(story.kind).toBe("bursty");
  });

  it("describes tight loops when recoverable usage is low", () => {
    const story = usagePatternStory(fixtureEndingBOptimal);
    expect(story.kind).toBe("tight-loop");
    expect(story.text).toContain("tight interactive loops");
  });

  it("never infers parallel work", () => {
    for (const summary of [fixtureEndingAEnable, fixtureEndingBOptimal, fixtureEndingCReceipt]) {
      expect(usagePatternStory(summary).text.toLowerCase()).not.toContain("parallel");
    }
  });
});
