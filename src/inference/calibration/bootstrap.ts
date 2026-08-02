import type { Thresholds } from "./thresholds.js";

/**
 * **Until calibration has data, the model's self-report cannot lift a proposal
 * into auto-apply on its own** (`triage.md` §4, ADR-0012).
 *
 * `p(extraction)` has no scorer behind it. It is the model's own report, which
 * ADR-0006 argues is a token distribution rather than a probability, and
 * shipping without this cap would trust it in exactly the period when nobody
 * has checked it against outcomes.
 *
 * ## The rule is a cap; the behaviour is derived
 *
 * Capping at the auto-apply edge means the product in `confidence.ts` cannot
 * reach that band on anything which also required a resolution judgement. So
 * the practical effect — **only unambiguous creates and updates to
 * already-resolved entities auto-apply** — falls out of the arithmetic rather
 * than being written anywhere as a rule. That is worth knowing when reading
 * this file and finding it shorter than the behaviour it produces.
 *
 * ## The one case the arithmetic does not cover
 *
 * `triage.md` §4 states the effect as "0.90 × anything < 1 is below 0.90",
 * which leaves `p(resolution) = 1` exactly on the line: 0.90 × 1 is 0.90, and
 * the band is inclusive, so a proposal resolution was *perfectly* sure of would
 * auto-apply during the very period the cap exists to prevent that. The
 * margin resolution reports reaches 1 only when the best candidate scores 1 and
 * the runner-up scores 0, so this is rare rather than impossible — and rare
 * plus silently wrong in the trust-destroying direction is the combination
 * `qa.md` §1 ranks first.
 *
 * So the rule is stated rather than derived: **during bootstrap, a proposal
 * that required a resolution judgement does not auto-apply**, which is what
 * the slice's verification asks for in as many words. Lowering the cap instead
 * would have closed the same gap by also closing creates out of auto-apply,
 * which is the friction PRD §4.1 rules out.
 *
 * ## Per provider and model version
 *
 * The count is per model, so switching models re-enters bootstrap even with
 * hundreds of corrections behind the old one. That is correct rather than an
 * inconvenience: a threshold measured against one model says nothing about
 * another (ADR-0008), and it makes a model change visibly costly, which is
 * honest.
 */

/**
 * How many Corrections end bootstrap.
 *
 * Fifty is ADR-0006's own minimum for an eval set rather than an anecdote, and
 * it is reached quickly — a Capture typically produces several proposals.
 */
export const BOOTSTRAP_CORRECTIONS = 50;

/**
 * The ceiling on `p(extraction)` while bootstrapping, for a given model.
 *
 * **Read off the threshold table rather than restated as its own number.** The
 * cap works by being exactly the auto-apply edge: a self-report alone may still
 * clear the bar, so a first-ever mention creates unattended, but it has no
 * headroom left to carry a resolution judgement over the line with it. Write
 * the 0.90 in two places and a calibration run that moves the threshold leaves
 * the cap behind, which silently either opens auto-apply during bootstrap or
 * closes it to creates as well.
 *
 * It takes the thresholds rather than reaching for the defaults because
 * thresholds are per provider and model version (ADR-0008), and a Proposal is
 * triaged against its own model's.
 */
export function bootstrapCapFor(thresholds: Thresholds): number {
  return thresholds.autoApply;
}

/** How many Corrections exist for the model a Proposal was produced under. */
export interface CalibrationState {
  readonly correctionCount: number;
  /** The band edges this model is triaged against, which set the cap. */
  readonly thresholds: Thresholds;
}

/** Whether this model still lacks the data to be trusted with its own numbers. */
export function isInBootstrap(correctionCount: number): boolean {
  return correctionCount < BOOTSTRAP_CORRECTIONS;
}

/**
 * `p(extraction)` as triage may use it.
 *
 * A cap rather than a replacement: a model reporting 0.6 is not lifted to 0.9,
 * because the point is to distrust confident self-reports rather than to
 * flatten every one of them into the same number.
 */
export function cappedExtraction(extraction: number, state: CalibrationState): number {
  if (!isInBootstrap(state.correctionCount)) return extraction;
  return Math.min(extraction, bootstrapCapFor(state.thresholds));
}

/**
 * Whether bootstrap forbids this proposal from applying unattended.
 *
 * True exactly when a resolution judgement was involved and the model has not
 * yet earned the right to be trusted with one. The cap above handles every
 * other case by arithmetic; this handles the boundary the arithmetic leaves
 * open, and states as a rule the thing `triage.md` §4 describes as an effect.
 */
export function isWithheldByBootstrap(
  confidences: { readonly resolution: number | null },
  state: CalibrationState,
): boolean {
  return isInBootstrap(state.correctionCount) && confidences.resolution !== null;
}
