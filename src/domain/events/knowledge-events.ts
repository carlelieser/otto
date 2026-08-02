import {
  ADD_TO_SET,
  CLEAR_FIELD,
  CREATE_ENTITY,
  MERGE_ENTITIES,
  RELATE,
  SET_FIELD,
  type AddToSetPayload,
  type ClearFieldPayload,
  type CreateEntityPayload,
  type KnowledgeCommandType,
  type MergeEntitiesPayload,
  type RelatePayload,
  type SetFieldPayload,
} from "../commands/knowledge-commands.js";

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
export const ENTITIES_MERGED = "EntitiesMerged";

/**
 * Every knowledge event type, in the order their Commands are declared.
 *
 * Merge's mirror is named in ADR-0009 and is deliberately not declared here. The
 * half that ships is merge (ADR-0012), and an event type declared ahead of the
 * code that folds it would be a payload shape nothing writes and nothing reads —
 * a version-1 shape frozen into an immutable log by nothing more than optimism.
 */
export const KNOWLEDGE_EVENT_TYPES = [
  ENTITY_CREATED,
  FIELD_SET,
  SET_MEMBER_ADDED,
  FIELD_CLEARED,
  ENTITIES_RELATED,
  ENTITIES_MERGED,
] as const;

export type KnowledgeEventType = (typeof KNOWLEDGE_EVENT_TYPES)[number];

/** All six ship at version 1, and rows are only ever added (ADR-0011). */
export const KNOWLEDGE_EVENT_VERSION = 1;

/**
 * The payload each event carries, **declared as the Command payload it was
 * built from** rather than restated.
 *
 * The translation from Command to event is a pass-through — only the tense
 * changes (`knowledge-translators.ts`) — so writing these out as five fresh
 * interfaces would be five shapes that must stay identical to five others with
 * nothing checking that they do. Aliasing says the thing that is true: a
 * `FieldSet` event holds exactly what the `SetField` Command held.
 *
 * If an event's payload ever needs to diverge from its Command's, that is a new
 * event *version* with an upcast (ADR-0011), and the alias here becomes a real
 * declaration at that point. Until then the alias is what keeps the two from
 * drifting apart silently.
 */
export interface KnowledgeEventPayloads {
  readonly [ENTITY_CREATED]: CreateEntityPayload;
  readonly [FIELD_SET]: SetFieldPayload;
  readonly [SET_MEMBER_ADDED]: AddToSetPayload;
  readonly [FIELD_CLEARED]: ClearFieldPayload;
  readonly [ENTITIES_RELATED]: RelatePayload;
  readonly [ENTITIES_MERGED]: MergeEntitiesPayload;
}

/** The event each Command produces: the same claim, in the past tense. */
export const EVENT_FOR_COMMAND = {
  [CREATE_ENTITY]: ENTITY_CREATED,
  [SET_FIELD]: FIELD_SET,
  [ADD_TO_SET]: SET_MEMBER_ADDED,
  [CLEAR_FIELD]: FIELD_CLEARED,
  [RELATE]: ENTITIES_RELATED,
  [MERGE_ENTITIES]: ENTITIES_MERGED,
} as const satisfies Record<KnowledgeCommandType, KnowledgeEventType>;
