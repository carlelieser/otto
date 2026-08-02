import type { ScoredCandidate } from "./scoring.js";

/**
 * Turning a scored shortlist into a decision, and **the margin into
 * `p(resolution)`** (`triage.md` §1).
 *
 * Three outcomes, and the third is not a failure:
 *
 * - **matched** — one candidate is clearly best.
 * - **none of these, with candidates rejected** — plausible candidates existed
 *   and none was good enough. This is the decision that manufactures a
 *   duplicate, and Slice 5 sends the resulting create to review rather than
 *   auto-applying it (`triage.md` §3).
 * - **none of these, unambiguous** — nothing plausible was found at all. A
 *   first-ever mention, which creates unattended.
 *
 * The distinction between the last two is load-bearing and is why this returns
 * a reason rather than a nullable id. Sending every first-ever mention to review
 * would make the first use of Otto a form to fill in, which is the failure
 * PRD §4.1 is built to avoid; auto-applying a create that rejected real
 * candidates is how the knowledge base fills with duplicate Sarahs.
 *
 * ## The bias
 *
 * Deliberately toward "none of these" over a wrong match (ADR-0009). A
 * duplicate Person is recoverable by merge; a fact attached to the wrong person
 * quietly corrupts what the user knows. Both thresholds below encode that
 * asymmetry, and the eval set reports the two error classes **separately**
 * precisely so that an implementation which improved blended accuracy by
 * shifting errors from "none" toward "wrong match" shows up as worse rather
 * than better (`qa.md` §6.1).
 */

/**
 * The score a candidate must reach before it can be matched at all.
 *
 * Below this, nothing on the shortlist is worth attaching a fact to, however
 * much better it is than the others — a margin between two bad candidates is
 * not evidence.
 */
export const MATCH_FLOOR = 0.55;

/**
 * The score below which a candidate is not even a plausible rejection.
 *
 * This is what separates the two "none of these" outcomes. A shortlist whose
 * best candidate is under this floor is a Mention nothing in the graph
 * plausibly matches, which is the unambiguous-create path.
 */
export const PLAUSIBILITY_FLOOR = 0.35;

/**
 * The margin at which a decision stops being ambiguous.
 *
 * Two candidates within this of each other are the case the adjudicator exists
 * for. Above it, the scorer has decided.
 */
export const AMBIGUITY_MARGIN = 0.15;

export const RESOLUTION_OUTCOMES = ["matched", "rejected_candidates", "unambiguous"] as const;

export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];

/** What resolution decided, and how confident the scorer is in it. */
export interface Resolution {
  readonly outcome: ResolutionOutcome;
  /** The chosen entity, present exactly when the outcome is `matched`. */
  readonly entityId: string | null;
  /**
   * `p(resolution)` — the scorer's confidence, in [0, 1].
   *
   * **The margin between the top two candidates**, not the top score. When
   * adjudication runs, this is still the number: an adjudicated pick among
   * near-identical candidates is not made confident by having been adjudicated
   * (`triage.md` §1).
   *
   * It is never combined with `p(extraction)` here or anywhere before triage.
   */
  readonly confidence: number;
  /** Whether the case was ambiguous enough to warrant adjudication. */
  readonly isAmbiguous: boolean;
}

/**
 * The decision `candidates` supports, best-first as `scoreCandidates` returns
 * them.
 *
 * Pure and deterministic: the same shortlist always produces the same decision,
 * which is what lets the eval set measure resolution at all.
 */
export function resolveFromScores(candidates: readonly ScoredCandidate[]): Resolution {
  const best = candidates[0];
  if (best === undefined) return NOTHING_FOUND;

  const margin = marginOf(candidates);
  if (best.score < PLAUSIBILITY_FLOOR) return NOTHING_FOUND;
  if (best.score < MATCH_FLOOR) {
    return {
      outcome: "rejected_candidates",
      entityId: null,
      confidence: margin,
      isAmbiguous: false,
    };
  }
  return {
    outcome: "matched",
    entityId: best.candidate.entity.id,
    confidence: margin,
    isAmbiguous: margin < AMBIGUITY_MARGIN,
  };
}

/**
 * Nothing plausible was found: the unambiguous-create path.
 *
 * Confidence is 1 because the claim being made is "no entity in the graph is
 * this one," and an empty or wholly implausible shortlist is strong evidence
 * for exactly that. It is not a hedge — a low number here would push a
 * first-ever mention toward review, which is the friction PRD §4.1 rules out.
 */
const NOTHING_FOUND: Resolution = {
  outcome: "unambiguous",
  entityId: null,
  confidence: 1,
  isAmbiguous: false,
};

/**
 * The gap between the best candidate and the runner-up.
 *
 * A single candidate has no runner-up, so its margin is measured against the
 * match floor instead: a lone candidate scoring 0.56 barely cleared the bar and
 * should not be as confident as a lone candidate scoring 0.99. Measuring
 * against zero would make every single-candidate resolution look decisive.
 */
function marginOf(candidates: readonly ScoredCandidate[]): number {
  const best = candidates[0]!.score;
  const runnerUp = candidates[1]?.score;
  if (runnerUp === undefined) {
    return clampToUnit((best - MATCH_FLOOR) / (1 - MATCH_FLOOR));
  }
  return clampToUnit(best - runnerUp);
}

function clampToUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}
