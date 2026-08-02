import type { FieldDefinition } from "../../domain/schema/field-types.js";
import { type EntityTypeSchema, isDateField, type OutputSchema } from "./output-schema.js";

/**
 * The output schema as a GBNF grammar, for the local path (`runtime.md` §2).
 *
 * Grammar-constrained decoding is what keeps the schema violation rate at or
 * near zero: a field name outside the grammar is not merely rejected after the
 * fact, it is unreachable during sampling. `qa.md` §6.3 is explicit that if the
 * violation rate is *not* near zero, the constraint is misconfigured rather
 * than the model being weak.
 *
 * It guarantees parseable output and **not correct output**, which
 * `runtime.md` §2 names as the single most likely technical assumption in Otto
 * to be wrong. A 7-8B model reliably produces valid JSON here and less reliably
 * produces the right values in it. That gap is what the eval set measures; this
 * file only closes the half a grammar can close.
 *
 * Generated from the same `OutputSchema` the JSON-Schema renderer reads, so the
 * three providers cannot disagree about what is being asked for — only about
 * how it is requested.
 */
export function toGbnf(schema: OutputSchema): string {
  return [
    ROOT_RULES,
    mentionAlternatives(schema.entityTypes),
    ...schema.entityTypes.map(entityTypeRule),
    ...schema.entityTypes.flatMap(fieldRules),
    dateRule(schema.datePrecisions),
    PRIMITIVE_RULES,
  ].join("\n\n");
}

/**
 * The envelope. `confidence` is a decimal in [0, 1] by construction rather than
 * by validation — a grammar that permitted any number would hand the parser a
 * clamp to do, and the clamp exists anyway for the cloud paths.
 */
const ROOT_RULES = `root       ::= "{" ws "\\"mentions\\"" ws ":" ws mentions ws "}"
mentions   ::= "[" ws "]" | "[" ws mention (ws "," ws mention)* ws "]"
confidence ::= "0" "." [0-9]+ | "1" ".0"* | "0" | "1"`;

/** A mention is one of the five entity variants, chosen by its `entity_type`. */
function mentionAlternatives(types: readonly EntityTypeSchema[]): string {
  const alternatives = types.map(({ entityType }) => `mention-${lower(entityType)}`).join(" | ");
  return `mention    ::= ${alternatives}`;
}

/**
 * One entity type's object, with its `entity_type` pinned to a literal.
 *
 * Pinning it is what ties the field list to the type: the model cannot emit
 * `entity_type: "Person"` beside a Project's fields, because the two are
 * different productions rather than two independent choices.
 */
function entityTypeRule({ entityType }: EntityTypeSchema): string {
  const name = lower(entityType);
  return `mention-${name} ::= "{" ws "\\"text\\"" ws ":" ws string ws ","
             ws "\\"entity_type\\"" ws ":" ws "\\"${entityType}\\"" ws ","
             ws "\\"confidence\\"" ws ":" ws confidence ws ","
             ws "\\"fields\\"" ws ":" ws fields-${name} ws "}"`;
}

/**
 * A type's field list, and one production per field it may claim.
 *
 * The field name is a literal in the grammar. That is the whole mechanism: to
 * emit `shoe_size` the model would have to sample a token sequence no
 * production reaches.
 */
function fieldRules({ entityType, fields }: EntityTypeSchema): string[] {
  const name = lower(entityType);
  const alternatives = fields.map((field) => `field-${name}-${dashed(field.name)}`).join(" | ");
  return [
    `fields-${name} ::= "[" ws "]" | "[" ws field-${name} (ws "," ws field-${name})* ws "]"`,
    `field-${name}  ::= ${alternatives}`,
    ...fields.map((field) => fieldRule(name, field)),
  ];
}

function fieldRule(typeName: string, field: FieldDefinition): string {
  const rule = `field-${typeName}-${dashed(field.name)}`;
  return `${rule} ::= "{" ws "\\"field\\"" ws ":" ws "\\"${field.name}\\"" ws ","
             ws "\\"value\\"" ws ":" ws ${valueRule(field)} ws "}"`;
}

/**
 * What a field's value may be: a closed enum's members, a resolved date, or a
 * string.
 *
 * Rendering an enum's members as literals means an out-of-set value is
 * unreachable on the local path — so `other` plus a `notes` entry (`schema.md`
 * §7) is produced by the model choosing `other`, which is what the escape hatch
 * asks of it, rather than by the parser rewriting an invalid value after the
 * fact. The parser does that too, for the cloud paths where nothing constrains
 * the token stream.
 */
function valueRule(field: FieldDefinition): string {
  if (isDateField(field)) return "date";
  if (field.type === "enum" && field.values !== undefined) {
    return field.values.map((value) => `"\\"${value}\\""`).join(" | ");
  }
  return "string";
}

/**
 * A resolved date: an instant, a precision marker, and the phrase it came from
 * (`schema.md` §8).
 *
 * `value` is nullable in the grammar because `relative_unresolved` stores no
 * timestamp. The grammar cannot enforce the *pairing* — that a null value and
 * `relative_unresolved` go together — since that is a relationship between two
 * fields rather than a shape, which is why `read-resolved-date.ts` checks it.
 */
function dateRule(precisions: readonly string[]): string {
  const alternatives = precisions.map((precision) => `"\\"${precision}\\""`).join(" | ");
  return `date       ::= "{" ws "\\"value\\"" ws ":" ws (string | "null") ws ","
             ws "\\"date_precision\\"" ws ":" ws precision ws ","
             ws "\\"phrase\\"" ws ":" ws string ws "}"
precision  ::= ${alternatives}`;
}

/** JSON strings and insignificant whitespace, as `llama.cpp`'s own examples define them. */
const PRIMITIVE_RULES = `string     ::= "\\"" char* "\\""
char       ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" (["\\\\bfnrt/] | "u" [0-9a-fA-F]{4})
ws         ::= | " " | "\\n" [ \\t]{0,20}`;

function lower(entityType: string): string {
  return entityType.toLowerCase();
}

/** GBNF rule names take no underscores, so `next_action` becomes `next-action`. */
function dashed(fieldName: string): string {
  return fieldName.replaceAll("_", "-");
}
