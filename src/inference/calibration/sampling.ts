import { BOOTSTRAP_CORRECTIONS } from "./bootstrap.js";

/**
 * **A slice of confident auto-applies is forced into review anyway**
 * (`triage.md` §6, ADR-0006).
 *
 * Without this, the correction log only ever describes the middle band. Nobody
 * looks at what auto-applied, so nobody corrects it, so the log says nothing at
 * all about whether the auto-apply threshold is too loose — which is the one
 * number the calibration apparatus exists to produce. The adjudications on
 * sampled proposals are the only unbiased measurement Otto has of its own error
 * rate.
 *
 * **It cannot be reconstructed retroactively**, which is why it ships in the
 * first commit that has an auto-apply band to sample from rather than with the
 * tooling that will eventually consume it.
 *
 * ## Two halves, both load-bearing
 *
 * A sampled proposal is **marked in the data** so calibration can find it
 * later, and appears in the review queue **indistinguishably from an ordinary
 * one**. A user who knows they are being measured adjudicates differently, and
 * a measurement that changes what it measures is not one.
 *
 * ## No off switch
 *
 * There is no environment variable, no settings toggle, and no debug flag, and
 * a test asserts their absence rather than trusting this comment. An instrument
 * that can be disabled will be disabled on the day it is most annoying, which
 * is precisely the day its data matters most.
 *
 * The draw is a parameter so a test can pin it. That is not a switch: a caller
 * can choose *which* proposals are sampled, and cannot choose that none is.
 */

/** How many Corrections mark the end of the middle sampling tier. */
const SETTLED_CORRECTIONS = 500;

/**
 * The rate at each tier, as data, most-sampled first.
 *
 * Early data is worth more per item than late data, and the friction should
 * fall as trust is earned — so the rate decays with the correction count rather
 * than staying flat. At a plausible early volume this is roughly one extra
 * review a day, which is the stated cost of the only number in the system that
 * is not a guess.
 */
export const SAMPLING_RATES = [
  { from: SETTLED_CORRECTIONS, rate: 0.05 },
  { from: BOOTSTRAP_CORRECTIONS, rate: 0.1 },
  { from: 0, rate: 0.2 },
] as const;

/** A source of draws in [0, 1). A parameter so tests can pin it, never to disable it. */
export type Draw = () => number;

/** The share of auto-applies sent to review anyway at this correction count. */
export function samplingRateFor(correctionCount: number): number {
  const tier = SAMPLING_RATES.find(({ from }) => correctionCount >= from);
  return tier!.rate;
}

/** What sampling needs to know: how much has been measured so far. */
export interface SamplingState {
  readonly correctionCount: number;
}

/**
 * Whether this proposal is one of the sampled ones.
 *
 * Strictly below the rate, so a draw of exactly 0.2 at a 20% rate is not
 * sampled — which is what makes the sampled share over a uniform run equal the
 * rate rather than exceed it by one draw's worth.
 */
export function isSampled(state: SamplingState, draw: Draw = Math.random): boolean {
  return draw() < samplingRateFor(state.correctionCount);
}
