/**
 * The four properties every field carries (`schema.md` §1), as types.
 *
 * The differ needs all four, and each is here rather than in prose because the
 * extractor's output schema, the differ's cardinality rules, and the entity
 * views all derive from this one declaration. A property described in a comment
 * is a property two implementations can disagree about.
 */

/**
 * What a value is. Deliberately narrow: there is no nested-object field
 * anywhere in the model, because a thing with structure is an entity or a
 * Relation, not a field (`schema.md` §1).
 *
 * `number` appears only on derived fields — `salience` is computed by
 * projection and never proposed — so nothing extractable is typed with it.
 */
export const FIELD_TYPES = ["text", "date", "enum", "number"] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * Whether a new value supersedes the old one or joins it.
 *
 * The property ADR-0010 moved out of a predicate vocabulary and into the
 * schema. A `single` field with a new value produces a supersession; a `set`
 * field unions and never silently drops a member.
 */
export const CARDINALITIES = ["single", "set"] as const;

export type Cardinality = (typeof CARDINALITIES)[number];

/**
 * Whether Extraction may propose a value for this field.
 *
 * `derived` fields are computed by projection and can never appear in a
 * Proposal. If the extractor emits one it is dropped and **the drop is logged
 * as a schema violation, not accepted quietly** (`schema.md` §1) — the second
 * half of that sentence is why this is an enum rather than a boolean, since a
 * field that is merely absent from the output schema produces silence.
 */
export const EXTRACTABILITIES = ["extractable", "derived"] as const;

export type Extractability = (typeof EXTRACTABILITIES)[number];

/**
 * The lowest-friction Disposition a change to this field may receive
 * (`schema.md` §1).
 *
 * Most fields are `auto`. A few carry `review`, meaning a change to that field
 * always waits for a human, because getting it wrong is expensive in a way a
 * wrong `notes` line is not.
 *
 * It is a floor rather than a decision, and the distinction is `add.md` §3's
 * fourth rule: a domain policy is asked about a *kind of change*, never about a
 * number. What triage does with this floor is Slice 5's, and everything it
 * weighs alongside it belongs to machinery rather than to knowledge (ADR-0002).
 * The floor is declared here because the table is the one place all four
 * properties of a field live together.
 */
export const DISPOSITION_FLOORS = ["auto", "review"] as const;

export type DispositionFloor = (typeof DISPOSITION_FLOORS)[number];

/** A field on an entity type, with the four properties the differ needs. */
export interface FieldDefinition {
  readonly name: string;
  readonly type: FieldType;
  readonly cardinality: Cardinality;
  readonly extractability: Extractability;
  readonly floor: DispositionFloor;
  /** The closed set of permitted values, for `enum` fields only. */
  readonly values?: readonly string[];
}

/** Whether Extraction is permitted to propose a value for this field. */
export function isExtractable(field: FieldDefinition): boolean {
  return field.extractability === "extractable";
}
