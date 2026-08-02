import { describe, expect, it } from "vitest";
import { type ResolutionCase, summariseResolution, verdictOf } from "./resolution-metrics.js";

function aCase(overrides: Partial<ResolutionCase> = {}): ResolutionCase {
  return {
    caseId: "case-1",
    expectedEntityId: "per-sarah",
    actualEntityId: "per-sarah",
    outcome: "matched",
    wasAdjudicated: false,
    ...overrides,
  };
}

describe("classifying one resolution", () => {
  it("calls the right entity a correct match", () => {
    expect(verdictOf(aCase())).toBe("correct_match");
  });

  it("calls a different entity a wrong match", () => {
    expect(verdictOf(aCase({ actualEntityId: "per-other" }))).toBe("wrong_match");
  });

  /** The recoverable error: a duplicate, which merge undoes. */
  it("calls declining to match a known entity a missed match", () => {
    expect(verdictOf(aCase({ actualEntityId: null }))).toBe("missed_match");
  });

  it("calls correctly declining on a genuinely new entity a correct none", () => {
    expect(verdictOf(aCase({ expectedEntityId: null, actualEntityId: null }))).toBe("correct_none");
  });

  /**
   * The expensive error: the Mention was a new person and Otto attached the
   * note to an existing one. Counted as a wrong match rather than as its own
   * class, because it is the same failure — a fact on the wrong entity.
   */
  it("calls matching a genuinely new entity a wrong match", () => {
    expect(verdictOf(aCase({ expectedEntityId: null, actualEntityId: "per-sarah" }))).toBe(
      "wrong_match",
    );
  });
});

describe("the resolution metrics", () => {
  it("reports match accuracy over the cases where an entity existed", () => {
    const metrics = summariseResolution([
      aCase(),
      aCase(),
      aCase({ actualEntityId: null }),
      aCase({ expectedEntityId: null, actualEntityId: null }),
    ]);

    expect(metrics.matchAccuracy).toBeCloseTo(2 / 3);
  });

  it("reports none accuracy separately from match accuracy", () => {
    const metrics = summariseResolution([
      aCase({ expectedEntityId: null, actualEntityId: null }),
      aCase({ expectedEntityId: null, actualEntityId: "per-sarah" }),
    ]);

    expect(metrics.noneAccuracy).toBeCloseTo(0.5);
  });

  it("counts every verdict class", () => {
    const metrics = summariseResolution([
      aCase(),
      aCase({ actualEntityId: "per-other" }),
      aCase({ actualEntityId: null }),
      aCase({ expectedEntityId: null, actualEntityId: null }),
    ]);

    expect(metrics.verdicts).toEqual({
      correct_match: 1,
      wrong_match: 1,
      missed_match: 1,
      correct_none: 1,
    });
  });

  /**
   * **The metric the design exists to protect.** An implementation trading
   * "none of these" errors for wrong matches must look worse here even when it
   * looks better on accuracy.
   */
  it("reports wrong matches as a share of errors, never blended with them", () => {
    const biasedRight = summariseResolution([
      aCase({ actualEntityId: null }),
      aCase({ actualEntityId: null }),
      aCase({ actualEntityId: "per-other" }),
    ]);
    const biasedWrong = summariseResolution([
      aCase({ actualEntityId: "per-other" }),
      aCase({ actualEntityId: "per-other" }),
      aCase({ actualEntityId: null }),
    ]);

    expect(biasedRight.wrongMatchShareOfErrors).toBeCloseTo(1 / 3);
    expect(biasedWrong.wrongMatchShareOfErrors).toBeCloseTo(2 / 3);
  });

  /**
   * The case a blended metric would hide: the same error count, redistributed
   * toward the expensive class. Overall accuracy is identical and the product
   * is worse.
   */
  it("distinguishes two runs with identical accuracy but opposite bias", () => {
    const safe = summariseResolution([aCase(), aCase({ actualEntityId: null })]);
    const dangerous = summariseResolution([aCase(), aCase({ actualEntityId: "per-other" })]);

    const sameErrorCount =
      safe.verdicts.wrong_match + safe.verdicts.missed_match ===
      dangerous.verdicts.wrong_match + dangerous.verdicts.missed_match;

    expect(sameErrorCount, "the two runs make the same number of errors").toBe(true);
    expect(safe.wrongMatchShareOfErrors).toBe(0);
    expect(dangerous.wrongMatchShareOfErrors).toBe(1);
  });

  /** No errors is not "no wrong matches among many", so it reports null. */
  it("reports no bias direction when there were no errors", () => {
    expect(summariseResolution([aCase()]).wrongMatchShareOfErrors).toBeNull();
  });

  it("reports how often the adjudicator was asked", () => {
    const metrics = summariseResolution([
      aCase({ wasAdjudicated: true }),
      aCase(),
      aCase(),
      aCase(),
    ]);

    expect(metrics.adjudicationRate).toBe(0.25);
  });

  it("reports nothing surprising for an empty corpus", () => {
    const metrics = summariseResolution([]);

    expect(metrics.cases).toBe(0);
    expect(metrics.wrongMatchShareOfErrors).toBeNull();
  });
});
