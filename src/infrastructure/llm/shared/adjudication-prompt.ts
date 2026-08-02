import type { AdjudicationRequest } from "../../../ports/adjudicator.js";

/**
 * The one adjudication prompt, shared by every adapter.
 *
 * The same arrangement `extraction-prompt.ts` uses and for the same reason:
 * ADR-0008 accepts that task-shaped ports put the prompt per adapter, and this
 * file is where the three copies do not drift. Per-adapter differences are
 * confined to *how* structured output is requested.
 *
 * The task is a small pick-one-of-N, which is a genuinely different shape from
 * extraction's whole-note structured generation — that is why it is a separate
 * port rather than a second method.
 */
export function adjudicationPrompt(request: AdjudicationRequest): string {
  return [
    ROLE,
    `Note:\n${request.noteText}`,
    `The note mentions "${request.mentionText}", which is a ${request.entityType}.`,
    candidateList(request),
    ANSWER_FORMAT,
  ].join("\n\n");
}

/**
 * What the model is being asked, and the bias it is being asked to hold.
 *
 * The last paragraph is the load-bearing one. ADR-0009 biases resolution toward
 * "none of these" over a wrong match — a duplicate Person is recoverable by
 * merge, a fact attached to the wrong person quietly corrupts what the user
 * knows — and a model given a list will pick from it unless told that declining
 * is a real answer. Saying so is cheap; the wrong pick is not.
 */
const ROLE = `You decide which known entity a note is referring to.

You are given a note, one name it mentions, and a short list of entities already
known. Decide which one the note means, if any.

Judge only from what the note says and what each candidate already is. Being on
the list is not evidence — the list was assembled by a name search, so a
candidate may simply share a name with someone else entirely.

If none of the candidates is the one the note means, say so. That is a correct
and common answer, and it is the right one whenever you are unsure. A wrong
match quietly corrupts what the user knows; declining merely creates a new
entity, which is easy to undo later.`;

/**
 * The shortlist, numbered from 1 for the model and converted back on read.
 *
 * Numbered rather than identified: **the model never sees an entity id**, so it
 * cannot emit one. That is what makes "it cannot invent an entity id"
 * structural (`add.md` §5.3) rather than a validation someone has to remember.
 */
function candidateList(request: AdjudicationRequest): string {
  const entries = request.candidates.map(
    (candidate, index) => `${index + 1}. ${candidate.name} — ${candidate.summary}`,
  );
  return `Candidates:\n${entries.join("\n")}`;
}

const ANSWER_FORMAT = `Answer with JSON: {"choice": <number>} naming the candidate, or {"choice": null}
for none of them. Return nothing else.`;
