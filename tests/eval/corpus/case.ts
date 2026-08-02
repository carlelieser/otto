import type { DatePrecision } from "../../../src/domain/values/resolved-date.js";
import type { EntityType } from "../../../src/domain/schema/entity-schema.js";

/**
 * One eval case: a note, and what a correct extraction of it claims.
 *
 * `qa.md` §2 rules out asserting an exact extraction *string* — such a test
 * fails for reasons unrelated to Otto being broken. So a case states what must
 * be *found* rather than what must be returned, and the harness scores recall
 * and precision against it (`qa.md` §6.1) rather than comparing objects.
 *
 * That is also why fields are optional per case. A case built to exercise date
 * precision says nothing about `summary`, and a scorer that counted the absence
 * of an unstated expectation as an error would measure the corpus's
 * completeness rather than the model's accuracy.
 */
export interface EvalCase {
  /** Unique, stable, and readable in a failure report. */
  readonly id: string;
  /** Which of `qa.md` §6.2's hard cases this one covers. */
  readonly covers: CorpusCategory;
  readonly note: string;
  /** The Capture timestamp relative dates resolve against. */
  readonly capturedAt: string;
  /** Every entity a correct extraction finds. An empty list is a real expectation. */
  readonly expected: readonly ExpectedMention[];
  /** Why this case is here, when that is not obvious from the note. */
  readonly why?: string;
}

/**
 * `qa.md` §6.2's list, as a closed set.
 *
 * Enumerated so the corpus can be checked for coverage rather than counted: 50
 * notes that all exercise the same path is not the regression suite ADR-0006
 * asks for, and a count alone cannot tell the difference.
 */
export const CORPUS_CATEGORIES = [
  "unambiguous-create",
  "same-name-different-person",
  "concurrent-mention",
  "mis-transcribed-name",
  "date-precision",
  "relative-unresolved",
  "notes-pressure-valve",
  "enum-outside-set",
  "degenerate-note",
  "no-extractable-entity",
  "ordinary",
] as const;

export type CorpusCategory = (typeof CORPUS_CATEGORIES)[number];

/** An entity a correct extraction finds, and what it claims about it. */
export interface ExpectedMention {
  /**
   * The name as the note wrote it. Scored case-insensitively and after
   * trimming, because a model returning "sarah" has found Sarah — the casing is
   * not what the metric is about.
   */
  readonly text: string;
  readonly entityType: EntityType;
  /** Field values a correct extraction claims. Unstated fields are not scored. */
  readonly fields?: readonly ExpectedField[];
}

/** One expected field value. */
export interface ExpectedField {
  readonly field: string;
  /**
   * The expected value for a non-date field, matched case-insensitively.
   *
   * Absent for a `notes` expectation whose wording is not predictable — there
   * the case asserts only that *something* landed in `notes`, which is what the
   * pressure valve is for.
   */
  readonly value?: string;
  /** For a date field: the instant it resolves to, or `null` when unresolvable. */
  readonly timestamp?: string | null;
  /** For a date field: the precision the note stated it at. */
  readonly precision?: DatePrecision;
}
