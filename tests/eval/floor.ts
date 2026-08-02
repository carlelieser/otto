import type { ExtractionMetrics } from "./metrics.js";

/**
 * `qa.md` §6.3's floor, as a checkable condition.
 *
 * Stated as a pass condition rather than as a target: **the local path produces
 * a usable knowledge base with more review friction, not a corrupted one.** The
 * three clauses below are that sentence made operational, and the slice does
 * not exit by lowering them — if the floor is not cleared, `runtime.md` §2 and
 * ADR-0016 both say the response is a larger minimum local model, never looser
 * thresholds and never a restored cloud default to hide it.
 */

/**
 * Schema violations must be at or near zero.
 *
 * Grammar constraints should guarantee this. `qa.md` §6.3 is explicit that a
 * non-zero rate means **the constraint is misconfigured**, not that the model
 * is weak — so this bar is about Otto's own configuration and is the one clause
 * a better model cannot fix.
 */
const MAXIMUM_VIOLATION_RATE = 0.01;

/**
 * How far below cloud the local path's field-value accuracy may sit.
 *
 * `qa.md` §6.3 asks for a *measured* margin rather than an assumed one, so this
 * is not a quality target — it is the line past which "worse" becomes
 * "corrupted". Local is expected to be worse; the question this answers is
 * whether it is still usable.
 */
const MAXIMUM_ACCURACY_MARGIN = 0.25;

/**
 * The floor local extraction must clear to be Otto's default, and why it did or
 * did not.
 */
export interface FloorResult {
  readonly cleared: boolean;
  /** Each clause, named, so a failure says which one and by how much. */
  readonly clauses: readonly FloorClause[];
  /**
   * Local's field-value accuracy minus cloud's — **the number `qa.md` §6.3 asks
   * to be recorded**, positive when local is worse.
   */
  readonly accuracyMargin: number;
}

export interface FloorClause {
  readonly name: string;
  readonly cleared: boolean;
  readonly detail: string;
}

/**
 * Whether the local run clears the floor against a cloud run of the same corpus.
 *
 * `cloud` is optional because the violation-rate clause is meaningful on its
 * own and is the one that gates a local-only checkout. The margin clauses need
 * both, and are reported as uncleared-for-lack-of-data rather than silently
 * passed when cloud is absent — a floor that passes because nothing measured it
 * is the failure mode this whole file exists to prevent.
 */
export function checkFloor(local: ExtractionMetrics, cloud?: ExtractionMetrics): FloorResult {
  const clauses = [
    violationClause(local),
    ...(cloud === undefined
      ? []
      : [accuracyClause(local, cloud), reviewFrictionClause(local, cloud)]),
  ];
  return {
    cleared: clauses.every(({ cleared }) => cleared),
    clauses,
    accuracyMargin:
      cloud === undefined ? Number.NaN : cloud.fieldValueAccuracy - local.fieldValueAccuracy,
  };
}

function violationClause(local: ExtractionMetrics): FloorClause {
  const cleared = local.schemaViolationRate <= MAXIMUM_VIOLATION_RATE;
  return {
    name: "schema violation rate at or near zero",
    cleared,
    detail: `${local.schemaViolationRate.toFixed(4)} per case, bar ${MAXIMUM_VIOLATION_RATE}${
      cleared ? "" : " — the grammar constraint is misconfigured, not the model weak"
    }`,
  };
}

function accuracyClause(local: ExtractionMetrics, cloud: ExtractionMetrics): FloorClause {
  const margin = cloud.fieldValueAccuracy - local.fieldValueAccuracy;
  return {
    name: "field-value accuracy worse than cloud by a measured margin",
    cleared: margin <= MAXIMUM_ACCURACY_MARGIN,
    detail: `local is ${(margin * 100).toFixed(1)} points behind cloud, bar ${(MAXIMUM_ACCURACY_MARGIN * 100).toFixed(0)}`,
  };
}

/**
 * How much of cloud's self-reported confidence local may claim before the two
 * are "matching" rather than "degrading".
 *
 * `qa.md` §6.3 names parity itself as the failure, so this is a *floor* on the
 * gap rather than a ceiling on it: local must report itself measurably less
 * sure. Small, because the claim is only that the direction is right.
 */
const MINIMUM_CONFIDENCE_GAP = 0.02;

/**
 * The clause that is easiest to get backwards.
 *
 * `qa.md` §6.3: **more proposals landing in review, not more wrong proposals
 * auto-applying.** A local run whose auto-apply rate matches cloud's is a red
 * flag, not a success — the degradation the design intends is lower confidence
 * and therefore more review.
 *
 * That makes this the one clause where being *too close* to cloud fails.
 * Triage is Slice 5, so the auto-apply rate itself is not computable here; what
 * is, is the input triage reads — `p(extraction)`, which Slice 5 treats as a
 * floor. Two things must hold, and they fail in opposite directions:
 *
 * - Local must report itself **less** confident than cloud. Equal confidence
 *   from a measurably weaker model is the parity §6.3 calls a red flag, because
 *   it is what would make the two auto-apply at the same rate.
 * - Local must not claim **better** precision than cloud, which is the
 *   signature of a model inventing entities — the corrupted-knowledge direction
 *   rather than the friction one.
 */
function reviewFrictionClause(local: ExtractionMetrics, cloud: ExtractionMetrics): FloorClause {
  const gap = cloud.meanConfidence - local.meanConfidence;
  const inventsLess = local.mentionPrecision <= cloud.mentionPrecision + MAXIMUM_ACCURACY_MARGIN;
  return {
    name: "degrades toward review rather than toward parity or invention",
    cleared: gap >= MINIMUM_CONFIDENCE_GAP && inventsLess,
    detail:
      `local reports ${(local.meanConfidence * 100).toFixed(1)}% mean confidence against cloud's ` +
      `${(cloud.meanConfidence * 100).toFixed(1)}%, a gap of ${(gap * 100).toFixed(1)} points ` +
      `(needs ≥ ${(MINIMUM_CONFIDENCE_GAP * 100).toFixed(0)}); precision ` +
      `${(local.mentionPrecision * 100).toFixed(1)}% against ${(cloud.mentionPrecision * 100).toFixed(1)}%`,
  };
}

/** The floor result as a readable block, for a CI log or a decision record. */
export function formatFloor(result: FloorResult): string {
  const verdict = result.cleared ? "CLEARED" : "NOT CLEARED";
  const margin = Number.isNaN(result.accuracyMargin)
    ? "margin against cloud: not measured (no cloud run)"
    : `margin against cloud: ${(result.accuracyMargin * 100).toFixed(1)} points of field-value accuracy`;
  const clauses = result.clauses.map(
    ({ name, cleared, detail }) => `  [${cleared ? "pass" : "FAIL"}] ${name}: ${detail}`,
  );
  return [`Local-extraction floor: ${verdict}`, margin, ...clauses].join("\n");
}
