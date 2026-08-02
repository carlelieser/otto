import {
  type DatePrecision,
  isDatePrecision,
  RELATIVE_UNRESOLVED,
  type ResolvedDate,
} from "../../domain/values/resolved-date.js";

/**
 * A date the model returned, validated into a `ResolvedDate` or dropped.
 *
 * The model does the resolving — the Capture timestamp is given to it as
 * context and dates come back absolute (`schema.md` §8). This checks what came
 * back, and the check that matters is the pairing: a `relative_unresolved`
 * beside a timestamp and an `exact` beside nothing are both contradictions a
 * grammar cannot prevent, because a grammar constrains shape and this is a
 * relationship between two fields.
 *
 * Both contradictions resolve toward the *looser* reading rather than being
 * dropped, because the phrase is the part that cannot be reconstructed. A note
 * saying "when the contract lands" has said something about time, and a
 * timestamp invented beside it is worse than no timestamp.
 */
export function readResolvedDate(raw: unknown): ResolvedDate | null {
  const candidate = (raw ?? {}) as RawDate;
  const phrase = readPhrase(candidate);
  const precision = readPrecision(candidate);
  if (phrase === "" || precision === null) return null;

  const timestamp = readTimestamp(candidate);
  if (precision === RELATIVE_UNRESOLVED || timestamp === null) {
    return { timestamp: null, precision: RELATIVE_UNRESOLVED, phrase };
  }
  return { timestamp, precision, phrase };
}

interface RawDate {
  readonly value?: unknown;
  readonly date_precision?: unknown;
  readonly phrase?: unknown;
}

/**
 * The words the note used, which every precision keeps and not only the
 * unresolved one.
 *
 * It is what the review queue shows a user deciding whether "Tuesday" was read
 * correctly, and it cannot be reconstructed from a timestamp afterwards
 * (ADR-0006). A date with no phrase is a date with no provenance, so it is
 * dropped rather than kept.
 */
function readPhrase(date: RawDate): string {
  return typeof date.phrase === "string" ? date.phrase.trim() : "";
}

function readPrecision(date: RawDate): DatePrecision | null {
  return isDatePrecision(date.date_precision) ? date.date_precision : null;
}

/**
 * The instant, normalised to the ISO 8601 UTC form the rest of Otto uses, or
 * `null` when the model emitted something unparseable.
 *
 * Normalised rather than passed through because `capture_id` and every other
 * derivation in the system fix the format to the millisecond (`runtime.md` §3),
 * and one instant formatted two ways compares as two instants. A model asked
 * for a date will return `2026-08-04`, `2026-08-04T00:00:00Z`, and
 * `2026-08-04T00:00:00.000Z` on different runs of the same note.
 */
function readTimestamp(date: RawDate): string | null {
  if (typeof date.value !== "string" || date.value.trim() === "") return null;
  const parsed = Date.parse(asUtc(date.value.trim()));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** A date with no time part, which the model returns for anything day-precision or coarser. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A bare `YYYY-MM-DD` read as UTC midnight rather than as local midnight.
 *
 * `Date.parse` already treats a date-only string as UTC, so this only makes
 * that explicit. It is spelled out because the same string *with* a time and no
 * zone parses as local, and a resolution that silently shifted by the runner's
 * offset would make the eval set's date-accuracy metric depend on where CI runs.
 */
function asUtc(value: string): string {
  return DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value;
}
