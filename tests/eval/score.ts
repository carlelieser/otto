import type { ResolvedDate } from "../../src/domain/values/resolved-date.js";
import type { Extraction, FieldValue, Mention } from "../../src/ports/extractor.js";
import type { EvalCase, ExpectedField, ExpectedMention } from "./corpus/case.js";

/**
 * Scoring one extraction against one expected result (`qa.md` §6.1).
 *
 * The metrics are counted rather than asserted. `qa.md` §2 is explicit that a
 * test asserting an exact extraction string fails for reasons unrelated to Otto
 * being broken, so nothing here compares objects — it counts what was found,
 * what was invented, and what was got wrong, and the harness reports rates.
 *
 * Matching is deliberately generous about surface form and strict about
 * substance: names match case-insensitively after trimming, and field values
 * match on a normalised comparison, because a model returning "Globex " has got
 * the employer right. What it is strict about is the entity type, the field
 * name, and a date's precision — those are the things a wrong answer is wrong
 * about.
 */

/** The counts one case contributes, summed across the corpus into rates. */
export interface CaseScore {
  readonly caseId: string;
  /** Expected mentions the extraction found. */
  readonly mentionsFound: number;
  /** Expected mentions it missed. The complement of recall. */
  readonly mentionsMissed: number;
  /** Mentions it returned that the case did not expect. The numerator of precision's error. */
  readonly mentionsInvented: number;
  /** Expected field values it got right. */
  readonly fieldsCorrect: number;
  /** Expected field values it got wrong or omitted. */
  readonly fieldsWrong: number;
  /** Expected dates whose instant matched. */
  readonly datesCorrect: number;
  readonly datesWrong: number;
  /** Expected dates whose `date_precision` matched. Scored separately (`qa.md` §6.1). */
  readonly precisionCorrect: number;
  readonly precisionWrong: number;
  /** Fields dropped as unknown or derived. Zero-tolerance. */
  readonly violations: number;
}

/** Everything one case's extraction contributed to the metrics. */
export function scoreCase(evalCase: EvalCase, extraction: Extraction): CaseScore {
  const matches = matchMentions(evalCase.expected, extraction.mentions);
  const fields = matches.flatMap(({ expected, actual }) => scoreFields(expected, actual));
  return {
    caseId: evalCase.id,
    mentionsFound: matches.length,
    mentionsMissed: evalCase.expected.length - matches.length,
    mentionsInvented: extraction.mentions.length - matches.length,
    violations: extraction.violations.length,
    ...totalled(fields),
  };
}

/** One expected mention paired with the returned mention that satisfies it. */
interface MentionMatch {
  readonly expected: ExpectedMention;
  readonly actual: Mention;
}

/**
 * Expected mentions paired with the ones that satisfy them, greedily and
 * without reuse.
 *
 * Without reuse is the part that matters. `same-name-different-person` expects
 * two mentions of "Sarah", and a matcher that let one returned Sarah satisfy
 * both would score full recall on a model that found one — which is precisely
 * the failure that case exists to catch.
 */
function matchMentions(
  expected: readonly ExpectedMention[],
  actual: readonly Mention[],
): MentionMatch[] {
  const unclaimed = [...actual];
  return expected.flatMap((wanted) => {
    const index = unclaimed.findIndex((mention) => satisfies(wanted, mention));
    if (index === -1) return [];
    return [{ expected: wanted, actual: unclaimed.splice(index, 1)[0]! }];
  });
}

/**
 * Whether a returned mention is the expected one.
 *
 * The entity type must match exactly — a Project found as an Idea is a wrong
 * answer, not a near miss. The name matches on containment in either direction,
 * because "Meridian rollout" and "Meridian" are the same project named at two
 * lengths, and penalising that would measure verbosity rather than recall.
 */
function satisfies(expected: ExpectedMention, actual: Mention): boolean {
  if (expected.entityType !== actual.entityType) return false;
  const wanted = normalise(expected.text);
  const found = normalise(actual.text);
  return wanted === found || wanted.includes(found) || found.includes(wanted);
}

/** What one expected field contributed, by metric. */
interface FieldOutcome {
  readonly kind: "field" | "date";
  readonly correct: boolean;
  /** For a date: whether `date_precision` matched, scored independently. */
  readonly precisionCorrect?: boolean;
}

function scoreFields(expected: ExpectedMention, actual: Mention): FieldOutcome[] {
  return (expected.fields ?? []).map((wanted) => scoreField(wanted, actual.fields));
}

function scoreField(expected: ExpectedField, actual: readonly FieldValue[]): FieldOutcome {
  const claimed = actual.filter((value) => value.field === expected.field);
  if (isDateExpectation(expected)) return scoreDate(expected, claimed);
  return { kind: "field", correct: claimed.some((value) => matchesValue(expected, value)) };
}

function isDateExpectation(expected: ExpectedField): boolean {
  return expected.precision !== undefined || expected.timestamp !== undefined;
}

/**
 * A date's instant and its precision, scored separately.
 *
 * `qa.md` §6.1 lists "date resolution accuracy" and "`date_precision`
 * correctness" as two metrics, and keeping them apart is the point: a model
 * that resolves the right instant and marks every date `exact` has one problem,
 * and a model that marks precision correctly and resolves the wrong day has
 * another. A blended number would hide both.
 */
function scoreDate(expected: ExpectedField, claimed: readonly FieldValue[]): FieldOutcome {
  const dates = claimed.map(({ value }) => value).filter(isResolvedDate);
  const instantMatches = dates.some((date) => date.timestamp === (expected.timestamp ?? null));
  return {
    kind: "date",
    correct: expected.timestamp === undefined ? dates.length > 0 : instantMatches,
    precisionCorrect: dates.some((date) => date.precision === expected.precision),
  };
}

function isResolvedDate(value: FieldValue["value"]): value is ResolvedDate {
  return typeof value === "object" && value !== null && "precision" in value;
}

/**
 * Whether a claimed value satisfies an expectation.
 *
 * An expectation with no `value` asserts only that the field was claimed at
 * all, which is how the `notes` pressure-valve cases are scored — the wording a
 * model chooses for a free-text note is not predictable, and asserting it would
 * be the exact-string test `qa.md` §2 rules out.
 */
function matchesValue(expected: ExpectedField, actual: FieldValue): boolean {
  if (expected.value === undefined) return true;
  if (typeof actual.value !== "string") return false;
  const wanted = normalise(expected.value);
  const found = normalise(actual.value);
  return wanted === found || found.includes(wanted);
}

function normalise(text: string): string {
  return text.trim().toLowerCase();
}

/** The four field and date counters, summed. */
function totalled(outcomes: readonly FieldOutcome[]) {
  const fields = outcomes.filter(({ kind }) => kind === "field");
  const dates = outcomes.filter(({ kind }) => kind === "date");
  return {
    fieldsCorrect: fields.filter(({ correct }) => correct).length,
    fieldsWrong: fields.filter(({ correct }) => !correct).length,
    datesCorrect: dates.filter(({ correct }) => correct).length,
    datesWrong: dates.filter(({ correct }) => !correct).length,
    precisionCorrect: dates.filter((outcome) => outcome.precisionCorrect === true).length,
    precisionWrong: dates.filter((outcome) => outcome.precisionCorrect !== true).length,
  };
}
