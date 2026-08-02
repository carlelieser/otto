import type { FieldDefinition } from "../../domain/schema/field-types.js";
import { type EntityTypeSchema, isDateField, type OutputSchema } from "./output-schema.js";

/**
 * The output schema as JSON Schema, for the providers that request structured
 * output by tool use or JSON mode rather than by grammar.
 *
 * The same `OutputSchema` `to-gbnf.ts` renders, in the other dialect. Both are
 * generated from `schema.md`'s tables, so the three providers are asked for the
 * same thing and differ only in how the asking is expressed — which is exactly
 * the boundary ADR-0008 draws around the cost of task-shaped ports.
 *
 * It is a weaker guarantee than the grammar. A schema attached to a tool
 * definition is an instruction the model usually follows, where a grammar is a
 * constraint on sampling it cannot violate. That difference is why
 * `parse-extraction.ts` enforces the same rules again rather than trusting
 * either, and why `unknown_field` is a violation reason at all.
 */
export function toJsonSchema(schema: OutputSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      mentions: {
        type: "array",
        items: { anyOf: schema.entityTypes.map((type) => mentionSchema(type, schema)) },
      },
    },
    required: ["mentions"],
    additionalProperties: false,
  };
}

/** A JSON Schema document, loosely typed because it is handed straight to an SDK. */
export type JsonSchema = Record<string, unknown>;

function mentionSchema(type: EntityTypeSchema, schema: OutputSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      text: { type: "string", description: "The name exactly as it appeared in the note." },
      entity_type: { const: type.entityType },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      fields: { type: "array", items: { anyOf: type.fields.map((f) => fieldSchema(f, schema)) } },
    },
    required: ["text", "entity_type", "confidence", "fields"],
    additionalProperties: false,
  };
}

/**
 * One field, with its name pinned to a constant.
 *
 * `const` rather than an enum of every field name, for the reason the grammar
 * uses separate productions: it ties the name to its value type, so a `due`
 * carrying a bare string and a `status` carrying a date are both expressible
 * failures rather than schema-valid ones.
 */
function fieldSchema(field: FieldDefinition, schema: OutputSchema): JsonSchema {
  return {
    type: "object",
    properties: { field: { const: field.name }, value: valueSchema(field, schema) },
    required: ["field", "value"],
    additionalProperties: false,
  };
}

function valueSchema(field: FieldDefinition, schema: OutputSchema): JsonSchema {
  if (isDateField(field)) return dateSchema(schema.datePrecisions);
  if (field.type === "enum" && field.values !== undefined) {
    return { type: "string", enum: [...field.values] };
  }
  return { type: "string" };
}

/**
 * A resolved date (`schema.md` §8). `value` is nullable because
 * `relative_unresolved` stores no timestamp, and `phrase` is required at every
 * precision because it is what the review queue shows and cannot be
 * reconstructed from a timestamp afterwards.
 */
function dateSchema(precisions: readonly string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      value: {
        type: ["string", "null"],
        description: "ISO 8601 UTC, resolved against the note's timestamp; null if unresolvable.",
      },
      date_precision: { type: "string", enum: [...precisions] },
      phrase: { type: "string", description: "The words the note used for this date." },
    },
    required: ["value", "date_precision", "phrase"],
    additionalProperties: false,
  };
}
