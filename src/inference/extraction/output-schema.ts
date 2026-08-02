import { ENTITY_SCHEMA, ENTITY_TYPES, type EntityType } from "../../domain/schema/entity-schema.js";
import { DATE_PRECISIONS } from "../../domain/values/resolved-date.js";
import { type FieldDefinition, isExtractable } from "../../domain/schema/field-types.js";

/**
 * The extractor's output schema, **generated from `schema.md`'s tables** rather
 * than hand-written beside them (`add.md` §5.2).
 *
 * That generation is what makes "the model cannot invent a field name"
 * structural rather than aspirational. A hand-written copy is a second
 * declaration that drifts: someone adds `role` to the Person table and the
 * grammar keeps rejecting it, or removes a field and the grammar keeps
 * accepting it. Here the schema tables are the only place a field name exists,
 * so an unknown name fails parsing before it reaches the differ.
 *
 * This module produces the *shape*; `to-gbnf.ts` and `to-json-schema.ts` render
 * it into what each provider needs. The split is the one ADR-0008 asks for:
 * per-adapter differences are confined to how structured output is requested,
 * and what is requested is shared.
 */

/** Every field a mention of `entityType` may claim, derived fields excluded. */
export function extractableFields(entityType: EntityType): readonly FieldDefinition[] {
  return ENTITY_SCHEMA[entityType].filter(isExtractable);
}

/**
 * The output shape, as data.
 *
 * One variant per entity type rather than one field list across all five,
 * because `employer` on a Project is as wrong as `shoe_size` on a Person and a
 * flattened union would accept it. `qa.md` §7.2's "unknown field names are
 * rejected at parse time" is only true of a per-type schema.
 */
export interface OutputSchema {
  readonly entityTypes: readonly EntityTypeSchema[];
  readonly datePrecisions: readonly string[];
}

export interface EntityTypeSchema {
  readonly entityType: EntityType;
  readonly fields: readonly FieldDefinition[];
}

/** The schema every adapter requests structured output against. */
export function outputSchema(): OutputSchema {
  return {
    entityTypes: ENTITY_TYPES.map((entityType) => ({
      entityType,
      fields: extractableFields(entityType),
    })),
    datePrecisions: [...DATE_PRECISIONS],
  };
}

/** Whether a field carries a resolved date rather than a string. */
export function isDateField(field: FieldDefinition): boolean {
  return field.type === "date";
}
