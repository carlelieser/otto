import { isChosenIndexInRange } from "../../ports/adjudicator.js";

/**
 * Reading an adjudicator's answer back into a choice.
 *
 * The model answers with a **position in the list it was given**, numbered from
 * 1, and this converts it to a zero-based index. That the answer is a position
 * rather than a name or an id is the whole of the hallucination defence
 * (`add.md` §5.3): the only ids the model has seen are none, so it cannot
 * invent one, and it cannot name a candidate ambiguously either — two
 * candidates called "Sarah" are two positions.
 *
 * ## Out-of-range is "none of these", not an error
 *
 * A model that answers `7` to a list of three has not chosen anything. Reading
 * that as none-of-these rather than throwing is deliberate and follows
 * ADR-0009's bias: the failure mode of a throw is a stalled Capture, and the
 * failure mode of picking anyway is a fact attached to the wrong person. The
 * conservative reading is the one that declines.
 *
 * This is a different judgement from the transport failures in
 * `provider-failure.ts`, which do throw — an unreachable model is "adjudication
 * did not happen", while a nonsense answer is an adjudication that reached no
 * conclusion.
 */
export function parseChoice(answer: unknown, candidateCount: number): number | null {
  const choice = (answer as { choice?: unknown })?.choice;
  if (choice === null || choice === undefined) return null;
  if (typeof choice !== "number") return null;

  const index = choice - 1;
  return isChosenIndexInRange(index, candidateCount) ? index : null;
}
