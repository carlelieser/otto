import {
  isQuiet,
  renderSections,
  type BriefSelection,
} from "../../inference/salience/brief-selection.js";
import type { BriefGenerator } from "../../ports/brief-generator.js";

/**
 * Selection to stored brief: generate prose over what was selected, and refuse
 * anything the generator invented (ADD §8).
 *
 * **Selection precedes generation**, and this is the seam. The selection is
 * already fixed by the time this runs — nothing here re-ranks, and nothing here
 * asks the model what belongs in the brief. It asks only for words about a list
 * it was handed.
 */

/** A brief as composed: the selection, the prose, and what wrote it. */
export interface ComposedBrief {
  readonly selection: BriefSelection;
  readonly prose: string;
  readonly provider: string;
  readonly modelVersion: string;
  /**
   * Entity names the generator used that were not selected, dropped from
   * nothing but recorded.
   *
   * Present on the result rather than logged and forgotten, for the reason
   * extraction's `violations` are (`ports/extractor.ts`): a rate nothing
   * carries is a rate nothing can measure. A brief with entries here is a brief
   * whose prose was refused.
   */
  readonly unselectedMentions: readonly string[];
}

/**
 * The line a brief with nothing to say says.
 *
 * "If everything is empty, the brief says so in one line. That is a legitimate
 * output" (`salience.md` §4). It is a constant rather than a model call:
 * asking an LLM to write about nothing is how a quiet day acquires
 * manufactured content.
 */
export const QUIET_DAY_PROSE = "Nothing needs your attention.";

/**
 * A brief composed from a selection.
 *
 * A quiet selection never reaches the generator. Otherwise the prose is
 * generated and then **checked against the selected set**: a brief naming an
 * entity that was not selected is refused and replaced by the selection
 * rendered plainly, because the alternative — storing prose that references
 * knowledge Otto did not surface — is the failure this constraint exists to
 * prevent.
 */
export async function composeBrief(
  selection: BriefSelection,
  generator: BriefGenerator,
): Promise<ComposedBrief> {
  if (isQuiet(selection)) return quietBrief(selection);
  const generated = await generator.generate({
    kind: selection.kind,
    coversFrom: selection.coversFrom,
    coversTo: selection.coversTo,
    sections: selection.sections,
  });
  const invented = unselectedMentions(generated.prose, selection);
  return {
    selection,
    prose: invented.length === 0 ? generated.prose : renderPlainly(selection),
    provider: generated.provider,
    modelVersion: generated.modelVersion,
    unselectedMentions: invented,
  };
}

/**
 * The names the prose uses that name no selected entity.
 *
 * Checked by name rather than by id, because names are what prose contains —
 * a generator that never sees an id cannot quote one, so an id-based check
 * would pass everything and prove nothing.
 *
 * The test is deliberately one-directional: every *selected* name that the
 * prose omits is fine, since a generator is free to leave things out. What is
 * refused is a capitalised name the selection does not account for.
 */
function unselectedMentions(prose: string, selection: BriefSelection): readonly string[] {
  const permitted = permittedNames(selection);
  return [...new Set(properNameRunsIn(prose))].filter((run) => !permitted.has(run.toLowerCase()));
}

/**
 * Every name the prose may use: each selected name whole, and each single word
 * of it.
 *
 * The single-word entries are what let "Sarah Chen" be called "Sarah" on second
 * mention. They are deliberately *only* single words: permitting every word
 * individually and then testing the prose word-by-word would accept "Chen
 * Project" from a selection of "Sarah Chen" and "Acme Project" — an entity
 * nobody selected, assembled from parts of two who were. Runs of two or more
 * capitalised words are therefore matched whole, against whole names.
 */
function permittedNames(selection: BriefSelection): ReadonlySet<string> {
  const permitted = new Set<string>();
  for (const section of selection.sections) {
    for (const entity of section.entities) {
      permitted.add(entity.name.toLowerCase());
      for (const word of entity.name.split(/\s+/)) permitted.add(word.toLowerCase());
    }
  }
  return permitted;
}

/**
 * Runs of adjacent capitalised words in the prose that are not
 * sentence-initial, each run kept whole.
 *
 * Whole runs rather than single words, so a two-word name is checked as a
 * two-word name. A blunt instrument otherwise, and knowingly so: it cannot tell
 * a person's name from a capitalised noun, so the check errs toward flagging.
 * `IGNORED_WORDS` carries the words that would otherwise fire constantly — a
 * brief cannot be written without weekdays and months.
 */
function properNameRunsIn(prose: string): readonly string[] {
  const withoutSentenceStarts = prose.replace(/(^|[.!?:\n]\s*)([A-Z])/g, (_, lead: string) => lead);
  return [...withoutSentenceStarts.matchAll(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*\b/g)]
    .map((match) => match[0])
    .filter((run) => !isIgnorable(run));
}

/** Whether every word of a run is one that ordinary prose capitalises anyway. */
function isIgnorable(run: string): boolean {
  return run.split(/\s+/).every((word) => IGNORED_WORDS.has(word.toLowerCase()));
}

/** Capitalised words that appear in ordinary prose and name no entity. */
const IGNORED_WORDS: ReadonlySet<string> = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "today",
  "tomorrow",
  "yesterday",
  "otto",
]);

/** The quiet-day brief: one line, no model call. */
function quietBrief(selection: BriefSelection): ComposedBrief {
  return {
    selection,
    prose: QUIET_DAY_PROSE,
    provider: "none",
    modelVersion: "none",
    unselectedMentions: [],
  };
}

/**
 * The selection as a plain list, for when the generated prose is refused.
 *
 * A brief still has to exist — it is the record of what mattered that day, and
 * dropping it because the prose was wrong would lose the selection too. This is
 * strictly what was selected, so it cannot fail the check that produced it.
 */
function renderPlainly(selection: BriefSelection): string {
  return renderSections(selection.sections);
}
