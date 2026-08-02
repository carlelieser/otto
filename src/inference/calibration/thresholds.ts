import type { Disposition } from "../../domain/policies/disposition.js";
import type { ModelIdentity } from "../../ports/proposal.js";

/**
 * The band edges, **as data keyed by provider and model version** (`triage.md`
 * §2, ADR-0008).
 *
 * ## These numbers are wrong on purpose
 *
 * 0.90 and 0.50 are initial values chosen to be wrong in the safe direction,
 * and the whole calibration apparatus exists to replace them with measured
 * ones. 0.90 is high because the two errors are not symmetric: an unnecessary
 * review costs the user a few seconds, and a confidently wrong auto-apply costs
 * them a fact they believe and never check. Expect the measured value to move
 * *down* as data arrives, and treat any impulse to move it down beforehand as
 * the thing calibration exists to prevent.
 *
 * 0.50 is a floor rather than a judgement — below even odds, showing the user a
 * proposal costs more attention than the proposal is worth. Discards are
 * recorded rather than deleted (`triage.md` §7), so a floor that turns out to
 * be too aggressive is recoverable by examining what it dropped.
 *
 * ## Why the key exists before there is anything to key on
 *
 * Every model resolves to the same initial values today, because no model has
 * been measured. The lookup takes the pair anyway: ADR-0008 calls retrofitting
 * this genuinely painful, and a Proposal must be triaged against **its own**
 * model's thresholds rather than whichever model happens to be configured when
 * it comes up for review three days later. That is why nothing here reads
 * ambient configuration — there is no current model for it to reach for.
 */

/** The band edges for one provider and model version. */
export interface Thresholds {
  /** `p(correct)` at or above this auto-applies, subject to the policy. */
  readonly autoApply: number;
  /** Below this, the proposal is discarded and the discard is recorded. */
  readonly discard: number;
}

/** The initial values, used for every model until one has been measured. */
export const DEFAULT_THRESHOLDS: Thresholds = { autoApply: 0.9, discard: 0.5 };

/**
 * Measured thresholds per model, empty until calibration has produced some.
 *
 * A `Map` rather than a literal object so the eventual measured entries are
 * data written by tooling rather than a source edit, and exported so a caller
 * can see that it is empty rather than inferring it from behaviour.
 */
export const MEASURED_THRESHOLDS: ReadonlyMap<string, Thresholds> = new Map();

/**
 * The thresholds this model is triaged against.
 *
 * Falls back to the initial values rather than throwing: an unmeasured model is
 * the ordinary case and will be for the whole of the MVP.
 */
export function thresholdsFor(
  model: ModelIdentity,
  measured: ReadonlyMap<string, Thresholds> = MEASURED_THRESHOLDS,
): Thresholds {
  return measured.get(keyFor(model)) ?? DEFAULT_THRESHOLDS;
}

/** How a model identity addresses a row. */
export function keyFor(model: ModelIdentity): string {
  return `${model.provider}/${model.modelVersion}`;
}

/**
 * The band `confidence` falls in.
 *
 * Both comparisons are `>=` on the lower edge, which is what puts 0.90 in the
 * high band and 0.50 in the middle one rather than the reverse.
 */
export function bandFor(confidence: number, thresholds: Thresholds): Disposition {
  if (confidence >= thresholds.autoApply) return "auto_apply";
  if (confidence >= thresholds.discard) return "needs_review";
  return "discard";
}
