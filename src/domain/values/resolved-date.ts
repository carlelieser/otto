/**
 * A date the extractor resolved against the Capture timestamp, carrying how
 * precisely the note actually stated it (`schema.md` §8).
 *
 * Notes say "Tuesday," not `2026-08-04`. Resolving that is Extraction's job —
 * `add.md` §5.1 uses date-noticing as its example of what Ingestion must not
 * do, and that rule stands. The Capture's timestamp is given to the extractor
 * as context and dates come back absolute.
 *
 * The precision marker is the half that is easy to drop and expensive to lose:
 * "sometime next quarter" and "on the 4th" must not become indistinguishable
 * timestamps. Precision is stored with the date and is what the UI renders
 * from, so a `quarter`-precision date displays as "Q3" and never as a specific
 * day.
 */

/**
 * How precisely a date was stated.
 *
 * Ordered loosest-last, which is the order the values are useful in: everything
 * before `relative_unresolved` carries a timestamp, and it does not.
 */
export const DATE_PRECISIONS = [
  "exact",
  "day",
  "month",
  "quarter",
  "year",
  "relative_unresolved",
] as const;

export type DatePrecision = (typeof DATE_PRECISIONS)[number];

/**
 * The honest failure case: "when the contract lands" is a real thing a note
 * says and is not a date.
 *
 * It stores no timestamp, keeps the phrase, and is excluded from anything
 * time-ordered (`schema.md` §8). Modelling it as a precision rather than as an
 * absent date is what keeps the phrase — a null date loses the fact that the
 * note said something about time at all.
 */
export const RELATIVE_UNRESOLVED: DatePrecision = "relative_unresolved";

/**
 * A resolved date: an absolute instant and the precision the note stated it at,
 * alongside the phrase it was resolved from.
 *
 * `phrase` is kept for every precision, not only the unresolved one. It is what
 * the review queue shows a user deciding whether "Tuesday" was read correctly,
 * and it cannot be reconstructed from the timestamp afterwards (ADR-0006).
 */
export interface ResolvedDate {
  /**
   * ISO 8601, UTC, millisecond precision — `null` exactly when precision is
   * `relative_unresolved`.
   *
   * A coarse precision still carries a timestamp: a `quarter`-precision date is
   * the quarter's first instant, and the marker is what stops the UI reading
   * that as a specific day.
   */
  readonly timestamp: string | null;
  readonly precision: DatePrecision;
  /** The words the note used, e.g. "next Tuesday" or "when the contract lands". */
  readonly phrase: string;
}

/** Whether a resolved date carries a timestamp anything time-ordered may use. */
export function isTimeOrdered(date: ResolvedDate): boolean {
  return date.precision !== RELATIVE_UNRESOLVED && date.timestamp !== null;
}

/** Whether `value` names one of the six precisions. */
export function isDatePrecision(value: unknown): value is DatePrecision {
  return DATE_PRECISIONS.includes(value as DatePrecision);
}

/**
 * Why a resolved date is not well-formed, or empty if it is.
 *
 * The two halves of §8's rule, checked rather than described: an unresolved
 * date carries no timestamp, and a resolved one carries a real instant. Both
 * are failures the grammar cannot prevent — a model constrained to emit a
 * `date_precision` field can still emit `relative_unresolved` beside a
 * timestamp, and the pair is contradictory rather than merely odd.
 */
export function resolvedDateViolations(date: ResolvedDate): readonly string[] {
  if (!isDatePrecision(date.precision)) return ["precision"];
  if (date.precision === RELATIVE_UNRESOLVED) {
    return date.timestamp === null ? [] : ["timestamp: unresolved dates carry none"];
  }
  return date.timestamp !== null && !Number.isNaN(Date.parse(date.timestamp))
    ? []
    : ["timestamp: resolved dates carry an instant"];
}
