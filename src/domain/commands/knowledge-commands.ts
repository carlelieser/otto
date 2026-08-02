import type { EntityValue } from "../knowledge/entity.js";
import type { EntityType } from "../schema/entity-schema.js";
import type { RelationName } from "../schema/relation-schema.js";

/**
 * The Commands the differ produces: the vocabulary of change to knowledge.
 *
 * A closed set, and that closure is where hallucination is structurally
 * prevented (`add.md` §5.4). **The model never emits a Command.** It emits
 * Mentions and claimed field values; the differ — deterministic, no LLM —
 * decides what change those imply against current state. So a Command can never
 * name a field that does not exist or an id that was never real, because
 * nothing that could invent either one is in the code path that builds it.
 *
 * These live in `domain/` because a Command is an expressed intent to change
 * knowledge (`CONTEXT.md`), which is knowledge's own vocabulary rather than
 * Otto's machinery — the ADR-0002 test: delete Otto and "set this Project's
 * status" is still a thing that happens to a project.
 */

export const CREATE_ENTITY = "CreateEntity";
export const SET_FIELD = "SetField";
export const ADD_TO_SET = "AddToSet";
export const CLEAR_FIELD = "ClearField";
export const RELATE = "Relate";

/** Every Command type the differ may emit. */
export const KNOWLEDGE_COMMAND_TYPES = [
  CREATE_ENTITY,
  SET_FIELD,
  ADD_TO_SET,
  CLEAR_FIELD,
  RELATE,
] as const;

export type KnowledgeCommandType = (typeof KNOWLEDGE_COMMAND_TYPES)[number];

/** A Mention resolved to nothing became a new entity. */
export interface CreateEntityPayload {
  readonly entityType: EntityType;
  readonly name: string;
}

/**
 * A `single` field takes a new value, superseding whatever it held.
 *
 * Supersession rather than contradiction: ADR-0010 chose it, and the old value
 * stays recoverable from the event log rather than living beside the new one.
 */
export interface SetFieldPayload {
  readonly field: string;
  readonly value: EntityValue;
}

/**
 * A `set` field gains a member.
 *
 * One Command per member rather than one carrying an array, because the union
 * is per member: a note repeating one known contact and adding one new one
 * should produce one Command, not a Command replacing the whole set.
 * **A `set` field never silently drops a member** — there is no Command here
 * that removes one, and removal is a `remove` Command that never auto-applies
 * (ADR-0007), which Slice 5 owns.
 */
export interface AddToSetPayload {
  readonly field: string;
  readonly value: EntityValue;
}

/**
 * A dependent field is cleared because the field it depends on changed.
 *
 * `blocker` is the case `schema.md` §4 names: it holds why a Project is
 * blocked, so a status change away from `blocked` makes it stale rather than
 * merely old. The differ emits this rather than the extractor proposing it,
 * because it is a consequence of a change rather than a claim the note made.
 */
export interface ClearFieldPayload {
  readonly field: string;
  /** The field whose change made this one stale, so the reason survives in the log. */
  readonly because: string;
}

/** Two entities are linked by a relation from the closed vocabulary. */
export interface RelatePayload {
  readonly relation: RelationName;
  readonly fromId: string;
  readonly fromType: EntityType;
  readonly toId: string;
  readonly toType: EntityType;
}

/** The payload each Command type carries, keyed by type. */
export interface KnowledgeCommandPayloads {
  readonly [CREATE_ENTITY]: CreateEntityPayload;
  readonly [SET_FIELD]: SetFieldPayload;
  readonly [ADD_TO_SET]: AddToSetPayload;
  readonly [CLEAR_FIELD]: ClearFieldPayload;
  readonly [RELATE]: RelatePayload;
}

/** The aggregate type a knowledge Command targets. */
export const ENTITY_AGGREGATE = "Entity";
