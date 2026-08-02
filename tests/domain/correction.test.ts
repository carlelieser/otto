import { describe, expect, it } from "vitest";
import {
  correctionViolations,
  isCounterfactual,
  type Correction,
} from "../../src/domain/knowledge/correction.js";
import { aCommand } from "../support/triage-builders.js";

/**
 * ADR-0006's schema decision, tested as a shape rather than as behaviour.
 *
 * The load-bearing property is negative: there is nowhere here to record "the
 * user said no." A Correction that could not name what the user chose instead
 * would be the boolean rejection log ADR-0006 exists to prevent, and no
 * downstream use — the eval set, the calibration curve, in-context examples —
 * can be built from one.
 */

function aCorrection(overrides: Partial<Correction> = {}): Correction {
  return {
    correctionId: "corr-1",
    proposalId: "prop-1",
    captureId: "cap-1",
    chosen: aCommand(),
    correctedAt: "2026-08-02T09:00:00.000Z",
    ...overrides,
  };
}

describe("what a Correction records", () => {
  /** `qa.md` §7.7: what the user chose instead, not a boolean rejection. */
  it("names the Command the user chose instead", () => {
    const chosen = aCommand({
      aggregate: { type: "Entity", id: "per-other-sarah", expectedVersion: 0 },
    });

    const correction = aCorrection({ chosen });

    expect(correction.chosen).toBe(chosen);
  });

  /** Attached to the Proposal that got it wrong *and* the Capture behind it. */
  it("attaches to both the Proposal and the Capture", () => {
    const correction = aCorrection({ proposalId: "prop-9", captureId: "cap-9" });

    expect(correction.proposalId).toBe("prop-9");
    expect(correction.captureId).toBe("cap-9");
  });

  /**
   * The negative half, checked against the type's own keys.
   *
   * A structural assertion rather than a comment, because "no rejection flag"
   * is the kind of claim that stays true only while someone is watching. A
   * boolean added here would satisfy every other test in this file.
   */
  it("has no field a rejection could be recorded in", () => {
    const keys = Object.keys(aCorrection());

    expect(keys).toEqual(["correctionId", "proposalId", "captureId", "chosen", "correctedAt"]);
  });
});

/**
 * The guard that makes the schema decision enforceable at runtime, since
 * `chosen` arriving over a transport is unknown until something checks it.
 *
 * It checks the shape rather than mere presence. Each case below is a rejection
 * flag that would pass a presence check while naming no change at all — which
 * is precisely what ADR-0006 rules out.
 */
describe("whether a chosen answer is a counterfactual", () => {
  it("is one when it names a Command with a target", () => {
    expect(isCounterfactual(aCommand())).toBe(true);
  });

  it("is not one when it is missing", () => {
    expect(isCounterfactual(undefined)).toBe(false);
    expect(isCounterfactual(null)).toBe(false);
  });

  it("is not one when it is a bare truthy value standing in for approval", () => {
    expect(isCounterfactual(true)).toBe(false);
    expect(isCounterfactual("rejected")).toBe(false);
  });

  it("is not one when it names no change", () => {
    expect(isCounterfactual({})).toBe(false);
  });

  it("is not one when it names no target to change", () => {
    expect(isCounterfactual({ type: "SetField" })).toBe(false);
  });

  it("is not one when the target names no version it was computed against", () => {
    expect(isCounterfactual({ type: "SetField", aggregate: { type: "Entity", id: "per-x" } })).toBe(
      false,
    );
  });
});

describe("a well-formed Correction", () => {
  it("has no violations", () => {
    expect(correctionViolations(aCorrection())).toEqual([]);
  });

  it("names every field that is missing", () => {
    const correction = { ...aCorrection(), correctionId: "", proposalId: "" };

    expect(correctionViolations(correction)).toEqual(["correctionId", "proposalId"]);
  });

  /** A Correction with no chosen Command is the rejection flag by omission. */
  it("rejects one that records no chosen Command", () => {
    const correction = { ...aCorrection(), chosen: undefined } as unknown as Correction;

    expect(correctionViolations(correction)).toContain("chosen");
  });
});
