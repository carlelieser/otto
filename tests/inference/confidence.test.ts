import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { combineConfidence } from "../../src/inference/calibration/confidence.js";

/**
 * `qa.md` §5.2 and `triage.md` §1.
 *
 * ```
 * p(correct) = p(extraction) × p(resolution)   -- when both apply
 * p(correct) = p(extraction)                   -- creates, and field changes
 *                                                 on an already-resolved entity
 * ```
 *
 * The whole function is two lines, and it is Tier 1 because it is the only
 * place in Otto where the two Confidences are allowed to meet.
 */

describe("combining the two confidences", () => {
  it("multiplies them when both apply", () => {
    expect(combineConfidence({ extraction: 0.9, resolution: 0.8 })).toBeCloseTo(0.72, 10);
  });

  /**
   * The boundary `qa.md` §5.2 asks for by name. A create has no candidate it
   * was chosen over, so there is no resolution judgement to discount by — and
   * `null` rather than 1 is what says so, since 1 would claim a resolution
   * happened and went perfectly.
   */
  it("is p(extraction) alone when no resolution judgement was involved", () => {
    expect(combineConfidence({ extraction: 0.94, resolution: null })).toBe(0.94);
  });

  /**
   * The bias `triage.md` §1 chose deliberately. Multiplication assumes an
   * independence that does not hold, so the product underestimates — and the
   * underestimate points toward review, which is where every other decision
   * here points.
   */
  it("never scores a proposal above either of its inputs", () => {
    fc.assert(
      fc.property(unitInterval(), unitInterval(), (extraction, resolution) => {
        const combined = combineConfidence({ extraction, resolution });

        expect(combined).toBeLessThanOrEqual(extraction);
        expect(combined).toBeLessThanOrEqual(resolution);
      }),
    );
  });

  it("stays within [0, 1] for any pair of inputs", () => {
    fc.assert(
      fc.property(
        unitInterval(),
        fc.option(unitInterval(), { nil: null }),
        (extraction, resolution) => {
          const combined = combineConfidence({ extraction, resolution });

          expect(combined).toBeGreaterThanOrEqual(0);
          expect(combined).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

function unitInterval(): fc.Arbitrary<number> {
  return fc.double({ min: 0, max: 1, noNaN: true });
}
