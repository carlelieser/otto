import type { EntityValue } from "../knowledge/entity.js";
import type { EntityType } from "../schema/entity-schema.js";
import type { RelationName } from "../schema/relation-schema.js";

/**
 * What happened to knowledge, in the past tense.
 *
 * One event per Command in the closed vocabulary, and the naming carries the
 * distinction ADR-0004 and CONTEXT.md rest on: a Command may be refused, and an
 * event is a thing that already happened. `SetField` is an intent; `FieldSet`
 * is a fact about the log.
 *
 * **These are what the log holds.** Every projection in Otto is rebuilt by
 * folding these in order (ADR-0005), which is why each payload carries enough
 * to be replayed without consulting anything else — a payload that needs the
 * current entity to be understood is a payload that stops meaning the same
 * thing when the code around it changes.
 */

export const ENTITY_CREATED = "EntityCreated";
export const FIELD_SET = "FieldSet";
export const SET_MEMBER_ADDED = "SetMemberAdded";
export const FIELD_CLEARED = "FieldCleared";
export const ENTITIES_RELATED = "EntitiesRelated";

/** Every knowledge event type, in the order their Commands are declared. */
export const KNOWLEDGE_EVENT_TYPES = [
  ENTITY_CREATED,
  FIELD_SET,
  SET_MEMBER_ADDED,
  FIELD_CLEARED,
  ENTITIES_RELATED,
] as const;

export type KnowledgeEventType = (typeof KNOWLEDGE_EVENT_TYPES)[number];

/** All five ship at version 1, and rows are only ever added (ADR-0011). */
export const KNOWLEDGE_EVENT_VERSION = 1;

export interface EntityCreatedPayload {
  readonly entityType: EntityType;
  readonly name: string;
}

export interface FieldSetPayload {
  readonly field: string;
  readonly value: EntityValue;
}

export interface SetMemberAddedPayload {
  readonly field: string;
  readonly value: EntityValue;
}

export interface FieldClearedPayload {
  readonly field: string;
  /** The field whose change made this one stale, so the reason survives replay. */
  readonly because: string;
}

export interface EntitiesRelatedPayload {
  readonly relation: RelationName;
  readonly fromId: string;
  readonly fromType: EntityType;
  readonly toId: string;
  readonly toType: EntityType;
}
