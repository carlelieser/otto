import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_CORRECTIONS,
  bootstrapCapFor,
  cappedExtraction,
  isInBootstrap,
  isWithheldByBootstrap,
} from "../../src/inference/calibration/bootstrap.js";
import { combineConfidence } from "../../src/inference/calibration/confidence.js";
import { bandFor, thresholdsFor } from "../../src/inference/calibration/thresholds.js";

/**
 * `qa.md` §5.4 and `triage.md` §4.
 *
 * The cap is the rule; the thing worth testing is the *consequence*, because
 * the consequence is stated as derived rather than as a rule of its own:
 * during bootstrap, only unambiguous creates and updates to already-resolved
 * entities auto-apply, since 0.90 × anything < 1 is below 0.90.
 */

const MODEL = { provider: "local", modelVersion: "qwen2.5-7b-instruct" } as const;
const THRESHOLDS = thresholdsFor(MODEL);

/** A calibration state with `count` corrections behind this model. */
function stateWith(count: number) {
  return { correctionCount: count, thresholds: THRESHOLDS };
}

describe("entering and leaving bootstrap", () => {
  it("is in bootstrap with no corrections at all", () => {
    expect(isInBootstrap(0)).toBe(true);
  });

  /** `qa.md` §5.4 asks for both sides of this boundary by name. */
  it("stays in bootstrap at the 49th correction", () => {
    expect(isInBootstrap(BOOTSTRAP_CORRECTIONS - 1)).toBe(true);
  });

  it("leaves bootstrap at the 50th", () => {
    expect(isInBootstrap(BOOTSTRAP_CORRECTIONS)).toBe(false);
  });

  /**
   * `qa.md` §5.4: switching models re-enters bootstrap even if 50 corrections
   * exist for the previous one. The count is looked up per provider and model
   * version, so this is a property of the lookup rather than of the rule — a
   * threshold measured against one model says nothing about another (ADR-0008).
   */
  it("re-enters bootstrap on a model switch despite the old model's corrections", () => {
    const counts = new Map([[`${MODEL.provider}/${MODEL.modelVersion}`, 500]]);

    const seasoned = counts.get(`${MODEL.provider}/${MODEL.modelVersion}`) ?? 0;
    const switched = counts.get("local/a-newer-model") ?? 0;

    expect(isInBootstrap(seasoned)).toBe(false);
    expect(isInBootstrap(switched)).toBe(true);
  });
});

describe("the cap on p(extraction)", () => {
  it("caps a self-report above the cap during bootstrap", () => {
    expect(cappedExtraction(1, stateWith(0))).toBe(bootstrapCapFor(THRESHOLDS));
  });

  /**
   * A floor rather than a rewrite: a model reporting 0.6 is not lifted to 0.9,
   * because the cap exists to distrust confident self-reports rather than to
   * flatten every one of them.
   */
  it("leaves a self-report below the cap alone", () => {
    expect(cappedExtraction(0.6, stateWith(0))).toBe(0.6);
  });

  it("stops capping once bootstrap is over", () => {
    expect(cappedExtraction(1, stateWith(BOOTSTRAP_CORRECTIONS))).toBe(1);
  });

  /**
   * The cap tracks the auto-apply edge rather than restating it, so a model
   * with measured thresholds bootstraps against its own. Written the other way
   * — 0.90 in two files — a calibration run moves one and leaves the other.
   */
  it("tracks a measured model's own auto-apply edge", () => {
    const measured = new Map([["local/strict", { autoApply: 0.95, discard: 0.6 }]]);
    const strict = thresholdsFor({ provider: "local", modelVersion: "strict" }, measured);

    expect(cappedExtraction(1, { correctionCount: 0, thresholds: strict })).toBe(0.95);
  });
});

/**
 * The derived effect `triage.md` §4 states in prose and `qa.md` §5.4 asks to be
 * tested as a consequence rather than as a rule.
 */
describe("what the cap means for auto-apply", () => {
  const thresholds = THRESHOLDS;

  /**
   * `qa.md` §5.4 by name: at maximum confidence on *both* figures. The cap
   * alone leaves this one exactly on the band edge, since 0.90 × 1 is 0.90 and
   * the band is inclusive, so the withholding rule is what closes it.
   */
  it("keeps a resolution-requiring proposal out of auto-apply at maximum confidence", () => {
    const confidences = { extraction: cappedExtraction(1, stateWith(0)), resolution: 1 };

    const reachesBand = bandFor(combineConfidence(confidences), thresholds) === "auto_apply";

    expect(reachesBand && !isWithheldByBootstrap(confidences, stateWith(0))).toBe(false);
  });

  /** The ordinary resolution-requiring case, which the arithmetic alone closes. */
  it("keeps a well-resolved proposal out of auto-apply during bootstrap", () => {
    const confidences = { extraction: cappedExtraction(1, stateWith(0)), resolution: 0.95 };

    expect(bandFor(combineConfidence(confidences), thresholds)).not.toBe("auto_apply");
  });

  it("stops withholding once bootstrap is over", () => {
    const state = stateWith(BOOTSTRAP_CORRECTIONS);

    expect(isWithheldByBootstrap({ resolution: 1 }, state)).toBe(false);
  });

  /**
   * The other half, and the reason the cap is 0.90 rather than lower: a create
   * has no resolution judgement to discount by, so it still reaches the band.
   * A cap that stopped creates too would make the first use of Otto a form to
   * fill in, which is the failure PRD §4.1 exists to avoid.
   */
  it("still lets an unambiguous create auto-apply during bootstrap", () => {
    const extraction = cappedExtraction(1, stateWith(0));

    const combined = combineConfidence({ extraction, resolution: null });

    expect(bandFor(combined, thresholds)).toBe("auto_apply");
  });
});
