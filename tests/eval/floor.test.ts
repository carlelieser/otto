import { describe, expect, it } from "vitest";
import { checkFloor } from "./floor.js";
import type { ExtractionMetrics } from "./metrics.js";

/**
 * The floor's own logic, tested deterministically.
 *
 * The measurement it gates cannot run in CI, which is exactly why this can:
 * a floor whose arithmetic is wrong would pass a bad local model or fail a good
 * one, and nobody would find out until the gate was being trusted.
 */

function metrics(overrides: Partial<ExtractionMetrics> = {}): ExtractionMetrics {
  return {
    provider: "local",
    modelVersion: "qwen2.5-7b-instruct",
    cases: 50,
    mentionRecall: 0.8,
    mentionPrecision: 0.85,
    fieldValueAccuracy: 0.75,
    dateResolutionAccuracy: 0.7,
    datePrecisionAccuracy: 0.7,
    schemaViolationRate: 0,
    ...overrides,
  };
}

const CLOUD = metrics({
  provider: "anthropic",
  modelVersion: "claude-sonnet-4-5",
  mentionRecall: 0.95,
  mentionPrecision: 0.93,
  fieldValueAccuracy: 0.9,
});

describe("the §6.3 floor", () => {
  it("clears when local is worse than cloud but within the margin", () => {
    expect(checkFloor(metrics(), CLOUD).cleared).toBe(true);
  });

  /**
   * The number `qa.md` §6.3 asks to be *recorded*, not merely compared. Positive
   * means local is behind, which is the expected direction.
   */
  it("records the margin against cloud as a number", () => {
    const { accuracyMargin } = checkFloor(metrics({ fieldValueAccuracy: 0.75 }), CLOUD);

    expect(accuracyMargin).toBeCloseTo(0.15);
  });

  describe("schema violations", () => {
    /**
     * Zero-tolerance, and the one clause a better model cannot fix: `qa.md`
     * §6.3 reads a non-zero rate as a misconfigured constraint.
     */
    it("fails when the violation rate is not near zero", () => {
      const result = checkFloor(metrics({ schemaViolationRate: 0.2 }), CLOUD);

      expect(result.cleared).toBe(false);
      expect(result.clauses[0]!.detail).toMatch(/misconfigured/);
    });

    it("is checked even with no cloud run to compare against", () => {
      expect(checkFloor(metrics({ schemaViolationRate: 0.2 })).cleared).toBe(false);
    });
  });

  describe("with no cloud run", () => {
    /**
     * A floor that passed because nothing measured it is the failure mode the
     * whole file exists to prevent, so the margin is reported absent rather
     * than assumed clear.
     */
    it("reports the margin as not measured rather than as zero", () => {
      expect(checkFloor(metrics()).accuracyMargin).toBeNaN();
    });

    it("checks only the clauses that do not need cloud", () => {
      expect(checkFloor(metrics()).clauses).toHaveLength(1);
    });
  });

  it("fails when local's field-value accuracy falls too far behind cloud", () => {
    const result = checkFloor(metrics({ fieldValueAccuracy: 0.4 }), CLOUD);

    expect(result.cleared).toBe(false);
  });

  /**
   * `qa.md` §6.3's clause that is easiest to get backwards: a local run whose
   * numbers match cloud's is a red flag, not a success. A weaker model claiming
   * *better* precision is the signature of invention, which is the
   * corrupted-knowledge direction rather than the friction one.
   */
  it("fails a local run whose precision implausibly exceeds cloud's", () => {
    const result = checkFloor(
      metrics({ mentionPrecision: 1 }),
      CLOUD.mentionPrecision === 1
        ? CLOUD
        : metrics({ provider: "anthropic", mentionPrecision: 0.5 }),
    );

    expect(result.cleared).toBe(false);
  });
});
