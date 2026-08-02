import { describe, expect, it } from "vitest";
import { readSourceFiles } from "../boundaries/source-files.js";
import {
  SAMPLING_RATES,
  isSampled,
  samplingRateFor,
} from "../../src/inference/calibration/sampling.js";

/**
 * `qa.md` §5.5 and `triage.md` §6. ADR-0006 is emphatic that this cannot be
 * reconstructed retroactively: without it the correction log only ever
 * describes the review band and says nothing about whether the auto-apply
 * threshold is too loose.
 */

describe("the decaying rate", () => {
  /** The tier boundaries `qa.md` §5.5 asks for: 20% / 10% / 5%. */
  it("samples a fifth during bootstrap", () => {
    expect(samplingRateFor(0)).toBe(0.2);
    expect(samplingRateFor(49)).toBe(0.2);
  });

  it("samples a tenth from the 50th correction", () => {
    expect(samplingRateFor(50)).toBe(0.1);
    expect(samplingRateFor(499)).toBe(0.1);
  });

  it("samples a twentieth from the 500th", () => {
    expect(samplingRateFor(500)).toBe(0.05);
    expect(samplingRateFor(10_000)).toBe(0.05);
  });

  /**
   * The decay reflects that early data is worth more per item than late data,
   * and that friction should fall as trust is earned. A rate that rose with
   * experience would be the instrument getting more annoying the longer it ran.
   */
  it("never increases as corrections accumulate", () => {
    const counts = [0, 25, 49, 50, 100, 499, 500, 5_000];

    const rates = counts.map(samplingRateFor);

    expect(rates).toEqual([...rates].sort((left, right) => right - left));
  });

  /** Every rate is a real fraction: an instrument that never fires is no instrument. */
  it("is always a positive fraction below one", () => {
    for (const { rate } of SAMPLING_RATES) {
      expect(rate).toBeGreaterThan(0);
      expect(rate).toBeLessThan(1);
    }
  });
});

describe("the draw", () => {
  it("samples when the draw falls below the rate", () => {
    expect(isSampled({ correctionCount: 0 }, () => 0.19)).toBe(true);
  });

  it("does not sample when the draw is at or above the rate", () => {
    expect(isSampled({ correctionCount: 0 }, () => 0.2)).toBe(false);
  });

  /**
   * `qa.md` §5.5: statistical sanity over a large synthetic run — a range, not
   * an exact assertion. A cycling draw stands in for randomness so the test
   * measures the rate rather than the generator.
   */
  it("approximates the configured rate over a large run", () => {
    const draws = sequentialDraws(10_000);

    const sampled = Array.from({ length: 10_000 }, () =>
      isSampled({ correctionCount: 100 }, draws),
    ).filter(Boolean).length;

    expect(sampled / 10_000).toBeGreaterThan(0.08);
    expect(sampled / 10_000).toBeLessThan(0.12);
  });
});

/**
 * `triage.md` §6: "an instrument that can be disabled will be, on the day it is
 * most annoying, which is the day the data matters most."
 *
 * The test `qa.md` §5.5 asks for: no environment variable, no settings toggle,
 * no debug flag. Checked against the source rather than against behaviour,
 * because the absence of a switch is not observable by calling the function.
 */
describe("no off switch", () => {
  const DISABLING_NAMES =
    /process\.env|OTTO_[A-Z_]*SAMPL|\bdisabled?\b|\benabled?\b|isEnabled|skipSampling|debugFlag/i;

  it("exposes no configuration path that disables sampling", async () => {
    const source = (await readSourceFiles()).find(
      (file) => file.path === "inference/calibration/sampling.ts",
    );

    expect(source?.text).toBeDefined();
    expect(withoutComments(source!.text)).not.toMatch(DISABLING_NAMES);
  });

  /**
   * The other half: nothing anywhere else may reach in and turn it off either.
   * A caller that branches on a flag before asking is the same off switch one
   * layer up.
   */
  it("is not gated behind a flag by any of its callers", async () => {
    const offenders = (await readSourceFiles())
      .filter((file) => file.path !== "inference/calibration/sampling.ts")
      .map((file) => ({ path: file.path, code: withoutComments(file.text) }))
      .filter((file) => /isSampled|samplingRateFor/.test(file.code))
      .filter((file) => DISABLING_NAMES.test(file.code))
      .map((file) => file.path);

    expect(offenders, "a caller gating sampling behind a flag").toEqual([]);
  });
});

/** Prose may explain the absence of a switch; code may not contain one. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Draws spread evenly across [0, 1), so the sampled share is exactly the rate. */
function sequentialDraws(period: number): () => number {
  let index = 0;
  return () => (index++ % period) / period;
}
