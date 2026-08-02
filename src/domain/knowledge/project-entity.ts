import type { DomainEvent } from "../events/domain-event.js";
import {
  ENTITIES_MERGED,
  ENTITIES_RELATED,
  ENTITY_CREATED,
  FIELD_CLEARED,
  FIELD_SET,
  SET_MEMBER_ADDED,
} from "../events/knowledge-events.js";
import type {
  AddToSetPayload,
  ClearFieldPayload,
  CreateEntityPayload,
  MergeEntitiesPayload,
  RelatePayload,
  SetFieldPayload,
} from "../commands/knowledge-commands.js";
import { mergedEntity, type MergeSides } from "./merge-entities.js";
import type { EntityType } from "../schema/entity-schema.js";
import { isSameValue, type Entity, type EntityValue } from "./entity.js";
import type { Relation } from "./relation.js";
import {
  emptyKnowledge,
  relationKey,
  type FieldProvenance,
  type KnowledgeState,
  type TouchedEntities,
} from "./projected-state.js";

/**
 * The fold every projection in Otto is built from: one event applied to one
 * state, producing the next (ADR-0005).
 *
 * **Pure, and that is what makes the rebuild property testable.** `qa.md` §7.1
 * asks that dropping every projection and rebuilding produce byte-identical
 * state for any log. A fold with no I/O in it makes that a property over a
 * function rather than a test that needs a database, so `application/` is left
 * with the part that is genuinely I/O: reading the log and writing the tables.
 *
 * Every branch is total and none throws. An event naming an entity that does
 * not exist is dropped rather than creating one — a projection that invented
 * entities from a partial log would report entities the log does not contain,
 * which is exactly the half-populated read `qa.md` §7.1 forbids.
 */
export function applyEvent(state: KnowledgeState, event: DomainEvent): KnowledgeState {
  return (FOLDS[event.type] ?? keepState)(state, event);
}

/** One fold per knowledge event type; anything else leaves the state alone. */
const FOLDS: Readonly<Record<string, Fold>> = {
  [ENTITY_CREATED]: createEntity,
  [FIELD_SET]: setField,
  [SET_MEMBER_ADDED]: addToSet,
  [FIELD_CLEARED]: clearField,
  [ENTITIES_RELATED]: relate,
  [ENTITIES_MERGED]: merge,
};

type Fold = (state: KnowledgeState, event: DomainEvent) => KnowledgeState;

/**
 * An event type this projection does not fold.
 *
 * `CaptureIngested` is the live case: it is in the same log and says nothing
 * about entities. Ignoring it is correct rather than lenient — a projection
 * that threw on an event type it did not recognise would make adding any new
 * event type a change to every projection.
 */
const keepState: Fold = (state) => state;

/** Every event in order, folded into one state. */
export function applyEvents(state: KnowledgeState, events: Iterable<DomainEvent>): KnowledgeState {
  let carried = state;
  for (const event of events) carried = applyEvent(carried, event);
  return carried;
}

/** The whole log folded from nothing: a rebuild from event zero. */
export function projectFromZero(events: Iterable<DomainEvent>): KnowledgeState {
  return applyEvents(emptyKnowledge(), events);
}

/**
 * The name is set through the same path as any other field, so it carries a
 * provenance pointer like the rest. A creating event that left `name` without
 * one would be the one field the provenance property could not hold for.
 */
function createEntity(state: KnowledgeState, event: DomainEvent): KnowledgeState {
  const { entityType, name } = event.payload as CreateEntityPayload;
  const id = event.aggregate.id;
  if (state.entities.has(id)) return state;
  const entity: Entity = { id, type: entityType as EntityType, fields: {}, version: 0 };
  return writeField(withEntity(state, entity), event, "name", [name]);
}

function setField(state: KnowledgeState, event: DomainEvent): KnowledgeState {
  const { field, value } = event.payload as SetFieldPayload;
  return state.entities.has(event.aggregate.id) ? writeField(state, event, field, [value]) : state;
}

/** A set unions: a member it already holds is not added twice. */
function addToSet(state: KnowledgeState, event: DomainEvent): KnowledgeState {
  const { field, value } = event.payload as AddToSetPayload;
  const entity = state.entities.get(event.aggregate.id);
  if (entity === undefined) return state;
  const held = entity.fields[field] ?? [];
  if (held.some((member) => isSameValue(member, value))) return state;
  return writeField(state, event, field, [...held, value]);
}

/** Cleared leaves the field absent rather than empty (`entity.ts`). */
function clearField(state: KnowledgeState, event: DomainEvent): KnowledgeState {
  const { field } = event.payload as ClearFieldPayload;
  const entity = state.entities.get(event.aggregate.id);
  if (entity === undefined) return state;
  const { [field]: _removed, ...remaining } = entity.fields;
  const next = { ...entity, fields: remaining, version: entity.version + 1 };
  return withoutPointer(withEntity(state, next), entity.id, field);
}

function relate(state: KnowledgeState, event: DomainEvent): KnowledgeState {
  const relation = toRelation(event.payload as RelatePayload);
  const key = relationKey(relation);
  const relations = new Map(state.relations);
  relations.set(key, relation);
  return { ...state, relations, touched: touchRelation(state.touched, key) };
}

/**
 * Two entities become one: the survivor absorbs the loser's values, the loser
 * leaves the projection, and a redirect records where it went (ADR-0009).
 *
 * **Nothing in the log is rewritten.** Every event against the merged-away id
 * remains exactly as it was, because at the time Otto genuinely believed there
 * were two. This branch is the whole of what a merge changes.
 *
 * A merge naming an entity that is not there is dropped like every other fold's
 * missing target, and a merge of an entity into itself is refused — it is not a
 * merge, and folding it would delete the entity it names twice.
 */
function merge(state: KnowledgeState, event: DomainEvent): KnowledgeState {
  const { mergedId } = event.payload as MergeEntitiesPayload;
  const survivor = state.entities.get(event.aggregate.id);
  const loser = state.entities.get(mergedId);
  if (survivor === undefined || loser === undefined || survivor.id === loser.id) return state;
  const absorbed = absorb(state, sidesOf(state, event, survivor, loser));
  return withRedirect(repointEdges(absorbed, loser.id, survivor.id), loser.id, survivor.id);
}

/** Both entities and the pointers each brought, gathered for the merge rule. */
function sidesOf(
  state: KnowledgeState,
  event: DomainEvent,
  survivor: Entity,
  loser: Entity,
): MergeSides {
  return {
    survivor,
    loser,
    survivorPointers: state.provenance.get(survivor.id) ?? new Map(),
    loserPointers: state.provenance.get(loser.id) ?? new Map(),
    mergePointer: pointerFor(event),
  };
}

/** The survivor rewritten with both sides' values, and the loser removed. */
function absorb(state: KnowledgeState, sides: MergeSides): KnowledgeState {
  const { entity, pointers } = mergedEntity(sides);
  const written = withPointers(withEntity(state, entity), sides.survivor.id, pointers);
  return withoutEntity(written, sides.loser.id);
}

/**
 * Every edge naming the merged-away identity repointed at the survivor.
 *
 * A relation is a reference made before the merge, and ADR-0009's promise is
 * that those still resolve afterwards. Leaving them alone would point the edge
 * at an id that appears in no list view — so the survivor's page would show one
 * fewer relation than the two entities had between them, which is a fact lost to
 * a merge that is supposed to lose nothing.
 *
 * Repointed here rather than resolved on read, unlike an entity id. A read
 * resolves one id to one entity; an edge repointed on read can **collide** with
 * an edge the survivor already had, and deduplicating at read time would mean
 * every relation query carried the redirect table. The map is keyed by name and
 * both ends, so rebuilding it here is what makes that collapse fall out.
 */
function repointEdges(state: KnowledgeState, fromId: string, toId: string): KnowledgeState {
  const relations = new Map<string, Relation>();
  for (const relation of state.relations.values()) {
    const moved = repointed(relation, fromId, toId);
    relations.set(relationKey(moved), moved);
    if (moved !== relation) touchRelation(state.touched, relationKey(moved));
  }
  return { ...state, relations };
}

/** The relation with either end that named `fromId` now naming `toId`. */
function repointed(relation: Relation, fromId: string, toId: string): Relation {
  if (relation.from.id !== fromId && relation.to.id !== fromId) return relation;
  return {
    ...relation,
    from: relation.from.id === fromId ? { ...relation.from, id: toId } : relation.from,
    to: relation.to.id === fromId ? { ...relation.to, id: toId } : relation.to,
  };
}

/** The loser's row and pointers gone from the projection, its id marked merged. */
function withoutEntity(state: KnowledgeState, id: string): KnowledgeState {
  const entities = new Map(state.entities);
  entities.delete(id);
  const provenance = new Map(state.provenance);
  provenance.delete(id);
  (state.touched.entities as Set<string>).delete(id);
  return { ...state, entities, provenance, touched: touchMerged(state.touched, id) };
}

function withRedirect(state: KnowledgeState, fromId: string, toId: string): KnowledgeState {
  const redirects = new Map(state.redirects);
  redirects.set(fromId, toId);
  return { ...state, redirects };
}

function touchMerged(touched: TouchedEntities, id: string): TouchedEntities {
  (touched.merged as Set<string>).add(id);
  return touched;
}

function toRelation(payload: RelatePayload): Relation {
  return {
    name: payload.relation,
    from: { id: payload.fromId, type: payload.fromType },
    to: { id: payload.toId, type: payload.toType },
  };
}

/** A field's new values, its version bump, and its provenance pointer, together. */
function writeField(
  state: KnowledgeState,
  event: DomainEvent,
  field: string,
  values: readonly EntityValue[],
): KnowledgeState {
  const entity = state.entities.get(event.aggregate.id);
  if (entity === undefined) return state;
  const fields = { ...entity.fields, [field]: values };
  const next = { ...entity, fields, version: entity.version + 1 };
  return withPointer(withEntity(state, next), entity.id, field, pointerFor(event));
}

function pointerFor(event: DomainEvent): FieldProvenance {
  return {
    eventId: event.eventId,
    provenance: event.provenance,
    recordedAt: event.recordedAt,
  };
}

/**
 * Writing an entity is what marks it touched.
 *
 * Every path that changes an entity goes through here, so the touched set
 * cannot fall behind what was written — the alternative, marking at each call
 * site, is five places that must each remember.
 */
function withEntity(state: KnowledgeState, entity: Entity): KnowledgeState {
  const entities = new Map(state.entities);
  entities.set(entity.id, entity);
  return { ...state, entities, touched: touchEntity(state.touched, entity.id) };
}

/**
 * The touched sets grow in place while the maps around them are copied.
 *
 * A deliberate exception to this module being free of mutation, and the reason
 * is arithmetic: copying the set on every event makes the fold quadratic in the
 * number of entities touched, which is the cost this set exists to avoid. It is
 * safe because the set is bookkeeping about the fold rather than knowledge — a
 * caller holding an earlier state sees the same entities either way, and the
 * only thing it could observe is a longer list of ids to rewrite.
 *
 * `markWritten` replaces the set rather than clearing it, so a writer never
 * empties one an in-flight fold is still adding to.
 */
function touchEntity(touched: TouchedEntities, id: string): TouchedEntities {
  (touched.entities as Set<string>).add(id);
  return touched;
}

function touchRelation(touched: TouchedEntities, key: string): TouchedEntities {
  (touched.relations as Set<string>).add(key);
  return touched;
}

function withPointer(
  state: KnowledgeState,
  entityId: string,
  field: string,
  pointer: FieldProvenance,
): KnowledgeState {
  const forEntity = new Map(state.provenance.get(entityId) ?? []);
  forEntity.set(field, pointer);
  return withPointers(state, entityId, forEntity);
}

function withoutPointer(state: KnowledgeState, entityId: string, field: string): KnowledgeState {
  const forEntity = new Map(state.provenance.get(entityId) ?? []);
  forEntity.delete(field);
  return withPointers(state, entityId, forEntity);
}

function withPointers(
  state: KnowledgeState,
  entityId: string,
  forEntity: ReadonlyMap<string, FieldProvenance>,
): KnowledgeState {
  const provenance = new Map(state.provenance);
  provenance.set(entityId, forEntity);
  return { ...state, provenance };
}

/** The entity with this id, or `undefined` when the log created no such entity. */
export function entityOf(state: KnowledgeState, id: string): Entity | undefined {
  return state.entities.get(id);
}

/** The event that last wrote `field`, or `undefined` when the field has no value. */
export function provenanceOf(
  state: KnowledgeState,
  entityId: string,
  field: string,
): FieldProvenance | undefined {
  return state.provenance.get(entityId)?.get(field);
}

/** Every edge in the projection, in the order the log created them. */
export function relationsIn(state: KnowledgeState): readonly Relation[] {
  return [...state.relations.values()];
}

/** Every merged-away id and the survivor it points at, one hop each. */
export function redirectsIn(state: KnowledgeState): ReadonlyMap<string, string> {
  return state.redirects;
}

/**
 * **The id `id` resolves to, following the chain to its end** (ADR-0009).
 *
 * Merging #4891 into #4172 and later #4172 into #5310 must resolve #4891 all the
 * way to #5310. A one-hop lookup answers that with #4172, which is an id that
 * appears in no list view — so a proposal queued before the second merge would
 * apply to an entity nobody can see.
 *
 * An id nothing merged away resolves to itself, so a caller needs no branch for
 * the ordinary case.
 *
 * The step count is bounded by the number of redirects, which is what makes a
 * corrupt cycle in the projection table terminate rather than hang every read.
 * The fold cannot produce one — a merged-away id is gone, so nothing can merge
 * it again — but this function also reads redirects loaded from a table.
 */
export function resolveRedirect(state: KnowledgeState, id: string): string {
  let resolved = id;
  for (let steps = 0; steps <= state.redirects.size; steps += 1) {
    const next = state.redirects.get(resolved);
    if (next === undefined) return resolved;
    resolved = next;
  }
  return resolved;
}

export { emptyKnowledge };
export type { FieldProvenance, KnowledgeState };
