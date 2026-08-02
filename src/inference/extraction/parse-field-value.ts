import type { FieldDefinition } from "../../domain/schema/field-types.js";
import type { ResolvedDate } from "../../domain/values/resolved-date.js";
import type { FieldValue } from "../../ports/extractor.js";
import { readResolvedDate } from "./read-resolved-date.js";

/**
 * One emitted value, typed by its field's declared type.
 *
 * Returns an array because one emitted field can produce two values: an enum
 * outside its closed set becomes `other` plus a `notes` entry (`schema.md` §7),
 * which is the pressure valve working rather than a failure. It returns empty
 * when the value is unusable, which is a drop the parser does not count as a
 * schema violation — the field name was legal and only its content was not, and
 * folding that into the zero-tolerance violation rate would make the metric
 * unreadable (`qa.md` §6.1).
 */
export function parseFieldValue(field: FieldDefinition, raw: unknown): FieldValue[] {
  if (field.type === "date") return dateValue(field, raw);
  if (field.type === "enum") return enumValue(field, raw);
  return textValue(field, raw);
}

/** The escape value every closed enum carries (`schema.md` §7). */
const OTHER = "other";

/** The field an out-of-set enum value is preserved in. */
const NOTES = "notes";

function textValue(field: FieldDefinition, raw: unknown): FieldValue[] {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value === "" ? [] : [{ field: field.name, value }];
}

/**
 * A closed enum's value, or `other` plus the specific value in `notes`.
 *
 * This is what keeps the differ's typing intact while making the pressure
 * visible: a run of `other` values in `relationship` is the signal the enum
 * needs a new member, and it arrives as data rather than as a bug report.
 * The `notes` entry is what stops the absence of an enum member meaning the
 * loss of a fact.
 */
function enumValue(field: FieldDefinition, raw: unknown): FieldValue[] {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "") return [];
  if (field.values?.includes(value) === true) return [{ field: field.name, value }];
  return [
    { field: field.name, value: OTHER },
    { field: NOTES, value: `${field.name}: ${value}` },
  ];
}

/**
 * A resolved date, dropped when the model emitted something that is not one.
 *
 * Nothing is resolved here: the *model* resolves relative dates against the
 * Capture timestamp, which it is given as context (`schema.md` §8), and this
 * validates what came back. A parser that re-resolved would be a second date
 * implementation quietly disagreeing with the first.
 */
function dateValue(field: FieldDefinition, raw: unknown): FieldValue[] {
  const date: ResolvedDate | null = readResolvedDate(raw);
  return date === null ? [] : [{ field: field.name, value: date }];
}
