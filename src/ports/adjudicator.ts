import type { EntityType } from "../domain/schema/entity-schema.js";

/**
 * A note and three or four candidates in, one choice or none out
 * (`add.md` §9).
 *
 * Invoked **only when scoring leaves the case genuinely ambiguous** (§5.3), so
 * it is not on the path of most Mentions. A small pick-one-of-N, which is a
 * genuinely different shape from extraction's whole-note structured generation
 * and is why it is a separate port rather than a second method on `Extractor`.
 *
 * **It cannot invent an entity id**, because the only ids it has ever seen are
 * the ones it was given. That is structural rather than validated — the return
 * type is an index into the candidates it was handed, not a string it composes
 * — and it is the same move the differ makes with Commands: hallucination is
 * prevented by the shape of the output, not by checking it afterwards.
 *
 * **Adjudicating does not make the answer confident.** When this runs, the
 * confidence is still the scorer's margin between the top two candidates
 * (`triage.md` §1). An adjudicated pick among near-identical candidates is a
 * pick among near-identical candidates.
 */
export interface Adjudicator {
  /**
   * Which of `request.candidates` the note refers to, or none of them.
   *
   * Throws when the model is unreachable or its answer cannot be read. A caller
   * that could not tell an outage from a considered "none of these" would
   * record a create the model never asked for — and under the resolution bias
   * that create is exactly the expensive kind, since it manufactures a
   * duplicate (ADR-0009).
   */
  adjudicate(request: AdjudicationRequest): Promise<Adjudication>;
}

/** Everything the adjudicator is given: the note, the mention, and the shortlist. */
export interface AdjudicationRequest {
  /** The Capture's text, so the model can read the mention in context. */
  readonly noteText: string;
  /** The name as it appeared in the note, and what kind of thing it is. */
  readonly mentionText: string;
  readonly entityType: EntityType;
  /** The shortlist, in scored order. Three or four; never the whole graph. */
  readonly candidates: readonly AdjudicationCandidate[];
}

/**
 * One candidate as the adjudicator sees it.
 *
 * Deliberately without an entity id. The model has no use for one — it answers
 * with a position in this list — and an id in the prompt is an id that can
 * appear in the output, which is the hallucination this port's shape exists to
 * make impossible.
 */
export interface AdjudicationCandidate {
  /** How the entity is known, e.g. "Sarah Chen". */
  readonly name: string;
  /** What Otto already believes about it, rendered for reading. */
  readonly summary: string;
}

/** The choice: a position in the candidate list, or none of them. */
export interface Adjudication {
  /**
   * The chosen candidate's index in `request.candidates`, or `null` for "none
   * of these".
   *
   * An index rather than an id or a name: the port cannot name an entity that
   * was not on the list, and it cannot name one ambiguously either — two
   * candidates called "Sarah" are two positions.
   */
  readonly chosenIndex: number | null;
  readonly provider: string;
  readonly modelVersion: string;
}

/**
 * The answer meaning "none of these", named rather than written as a bare null
 * at each call site.
 *
 * Resolution is deliberately biased toward this over a wrong match (ADR-0009):
 * a duplicate Person is recoverable by merge, a fact attached to the wrong
 * person quietly corrupts what the user knows.
 */
export const NONE_OF_THESE = null;

/** Whether an index names a candidate that was actually on the list. */
export function isChosenIndexInRange(
  chosenIndex: number | null,
  candidateCount: number,
): chosenIndex is number {
  if (chosenIndex === NONE_OF_THESE) return false;
  return Number.isInteger(chosenIndex) && chosenIndex >= 0 && chosenIndex < candidateCount;
}
