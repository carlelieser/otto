import type { FieldDefinition } from "./field-types.js";

/**
 * `schema.md` §2-§5 as data: the list of things Otto is allowed to know.
 *
 * **This is the source the extractor's output schema is generated from**, which
 * is what makes "the model cannot invent a field name" structural rather than
 * aspirational (`add.md` §5.2). A field absent from these tables is absent from
 * the grammar the model decodes under and absent from the parser, so an unknown
 * name fails before it reaches the differ rather than being caught by a check
 * someone has to remember to write.
 *
 * It is not the SQL schema. Where this file and `schema.md` disagree,
 * `schema.md` is right and this is a bug — the tables were transcribed by hand
 * and `tests/domain/entity-schema.test.ts` is what pins them.
 */

/** The five entity types (`schema.md` §2). A closed set; adding one is a schema change. */
export const ENTITY_TYPES = ["Person", "Project", "Idea", "Event", "Task"] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * The five fields meaning the same thing on every entity type (`schema.md` §2).
 *
 * Spread into each table below rather than looked up separately, so that "every
 * field on this entity" is one array and the generator has nothing to join.
 */
const SHARED_FIELDS: readonly FieldDefinition[] = [
  // Renaming is identity-adjacent, which is why it never auto-applies (§6).
  {
    name: "name",
    type: "text",
    cardinality: "single",
    extractability: "extractable",
    floor: "review",
  },
  // Feeds candidate generation directly. Never shrinks except by explicit user action.
  {
    name: "aliases",
    type: "text",
    cardinality: "set",
    extractability: "extractable",
    floor: "auto",
  },
  // The most frequently superseded field in the model.
  {
    name: "summary",
    type: "text",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
  // The escape hatch (§7): standalone facts that do not fit a typed field.
  { name: "notes", type: "text", cardinality: "set", extractability: "extractable", floor: "auto" },
  // Computed by projection (`add.md` §8). Never proposed, never written by a Command.
  {
    name: "salience",
    type: "number",
    cardinality: "single",
    extractability: "derived",
    floor: "auto",
  },
];

/** `relationship` on a Person: how they relate to the user. Closed, with `other`. */
export const RELATIONSHIP_VALUES = [
  "colleague",
  "friend",
  "family",
  "client",
  "acquaintance",
  "other",
] as const;

/** `status` on a Project. The one field the daily brief leans on hardest. */
export const PROJECT_STATUS_VALUES = ["active", "blocked", "paused", "done", "abandoned"] as const;

/** `status` on an Idea. `promoted` is paired with a `became` Relation. */
export const IDEA_STATUS_VALUES = ["open", "promoted", "dropped"] as const;

/** `kind` on an Event. */
export const EVENT_KIND_VALUES = [
  "meeting",
  "call",
  "deadline",
  "milestone",
  "social",
  "other",
] as const;

/**
 * `status` on a Task. No `in_progress` — PRD §6 is explicit that Otto is not a
 * task manager, and the state that would justify it is project-level.
 */
export const TASK_STATUS_VALUES = ["open", "done", "dropped"] as const;

/** Someone in the user's life, with an identity that persists through renaming (§3). */
const PERSON_FIELDS: readonly FieldDefinition[] = [
  // Superseded on change — the job history lives in the event log, not in a set.
  {
    name: "employer",
    type: "text",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
  {
    name: "role",
    type: "text",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
  // Free text, deliberately not structured. "Lisbon" and "the Berlin office" both pass.
  {
    name: "location",
    type: "text",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
  {
    name: "relationship",
    type: "enum",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
    values: RELATIONSHIP_VALUES,
  },
  // A set because people have several and rarely lose them.
  {
    name: "contact",
    type: "text",
    cardinality: "set",
    extractability: "extractable",
    floor: "auto",
  },
  // Derived: the most recent Capture mentioning this Person as contact rather than reference.
  {
    name: "last_contact_at",
    type: "date",
    cardinality: "single",
    extractability: "derived",
    floor: "auto",
  },
];

/** An ongoing effort, which may outlive the people associated with it (§4). */
const PROJECT_FIELDS: readonly FieldDefinition[] = [
  {
    name: "status",
    type: "enum",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
    values: PROJECT_STATUS_VALUES,
  },
  // Cleared by a status change away from `blocked` — the differ handles this (§6).
  {
    name: "blocker",
    type: "text",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
  // A description carried on the Project, distinct from a tracked Task.
  {
    name: "next_action",
    type: "text",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
  {
    name: "outcome",
    type: "text",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
  {
    name: "due",
    type: "date",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
  {
    name: "started_at",
    type: "date",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
];

/** A thought worth keeping that is not yet a Project or a Task (§5). */
const IDEA_FIELDS: readonly FieldDefinition[] = [
  // The one field that carries real prose.
  {
    name: "body",
    type: "text",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
  {
    name: "status",
    type: "enum",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
    values: IDEA_STATUS_VALUES,
  },
];

/** Something that happened or will happen at a point in time (§5). */
const EVENT_FIELDS: readonly FieldDefinition[] = [
  // Resolved against the Capture timestamp — see §8 and `resolve-dates.ts`.
  {
    name: "occurred_at",
    type: "date",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
  {
    name: "ends_at",
    type: "date",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
  {
    name: "location",
    type: "text",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
  {
    name: "kind",
    type: "enum",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
    values: EVENT_KIND_VALUES,
  },
  // Only meaningful for past events, and typically arrives in a later Capture.
  {
    name: "outcome",
    type: "text",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
];

/** Something the user intends to do (§5). */
const TASK_FIELDS: readonly FieldDefinition[] = [
  {
    name: "status",
    type: "enum",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
    values: TASK_STATUS_VALUES,
  },
  {
    name: "due",
    type: "date",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
  {
    name: "done_at",
    type: "date",
    cardinality: "single",
    extractability: "extractable",
    floor: "auto",
  },
];

/** Every field of every entity type, shared fields first. */
export const ENTITY_SCHEMA: Readonly<Record<EntityType, readonly FieldDefinition[]>> = {
  Person: [...SHARED_FIELDS, ...PERSON_FIELDS],
  Project: [...SHARED_FIELDS, ...PROJECT_FIELDS],
  Idea: [...SHARED_FIELDS, ...IDEA_FIELDS],
  Event: [...SHARED_FIELDS, ...EVENT_FIELDS],
  Task: [...SHARED_FIELDS, ...TASK_FIELDS],
};

/** The field named `fieldName` on `entityType`, or `undefined` if there is none. */
export function findField(entityType: EntityType, fieldName: string): FieldDefinition | undefined {
  return ENTITY_SCHEMA[entityType].find((field) => field.name === fieldName);
}

/** Whether `value` names one of the five entity types. */
export function isEntityType(value: unknown): value is EntityType {
  return ENTITY_TYPES.includes(value as EntityType);
}
