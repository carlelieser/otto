import { canonicalProvenance } from "../values/provenance.js";
import type { Entity } from "./entity.js";
import type { Relation } from "./relation.js";
import type { FieldProvenance, KnowledgeState } from "./projected-state.js";

/**
 * A projection as one canonical string, for comparing two rebuilds.
 *
 * `qa.md` §7.1 asks that a rebuild be **byte-identical**, which needs a
 * definition of bytes: two projections holding the same knowledge must produce
 * the same string even when their maps were filled in different orders. So
 * every collection is sorted by key here, and nothing relies on insertion
 * order.
 *
 * Sorting is what makes the comparison meaningful rather than accidental. A
 * comparison over unsorted maps passes today because both rebuilds happen to
 * fold the same log in the same order, and would keep passing if the fold
 * started depending on that order — which is the bug the property exists to
 * catch. Chunked catch-up produces the same knowledge by a different insertion
 * path, and that is the case only a canonical form distinguishes.
 *
 * **The output is a comparison key, not a storage format.** Nothing parses it
 * back, so it is free to be whatever compares most cleanly. What a snapshot
 * stores is `snapshot-state.ts`, which is a different shape for a different
 * job — one that has to survive a round-trip, where this one only has to be
 * stable.
 */
export function serialiseKnowledge(state: KnowledgeState): string {
  return JSON.stringify({
    entities: serialiseEntities(state),
    provenance: serialiseProvenance(state),
    relations: serialiseRelations(state),
    redirects: sortedEntries(state.redirects),
  });
}

function serialiseEntities(state: KnowledgeState): unknown[] {
  return sortedEntries(state.entities).map(([id, entity]) => serialiseEntity(id, entity));
}

function serialiseProvenance(state: KnowledgeState): unknown[] {
  return sortedEntries(state.provenance).map(([id, pointers]) => [
    id,
    sortedEntries(pointers).map(([field, pointer]) => [field, serialisePointer(pointer)]),
  ]);
}

function serialiseRelations(state: KnowledgeState): unknown[] {
  return sortedEntries(state.relations).map(([key, relation]) => [
    key,
    serialiseRelation(relation),
  ]);
}

/** A map's entries, ordered by key so two equal maps serialise alike. */
function sortedEntries<Value>(map: ReadonlyMap<string, Value>): [string, Value][] {
  return [...map.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Field *values* keep their order, and only the field names are sorted.
 *
 * A `set` field's order is the order the log added its members in, which is
 * part of what the projection holds rather than an artefact of how it was
 * built — two logs adding the same aliases in different orders are different
 * projections and must not compare equal.
 */
function serialiseEntity(id: string, entity: Entity): unknown {
  return [
    id,
    {
      type: entity.type,
      version: entity.version,
      fields: Object.keys(entity.fields)
        .sort()
        .map((name) => [name, entity.fields[name]]),
    },
  ];
}

/**
 * The provenance record is serialised through `canonicalProvenance` rather than
 * field by field here.
 *
 * Restating its six fields in this file would be a second declaration of a
 * shape `domain/values/provenance.ts` already owns, drifting silently the first
 * time one gains a field — the failure `knowledge-events.ts` avoids by aliasing
 * its payloads rather than redeclaring them. It also keeps this module clear of
 * `add.md` §3's fourth rule, which reserves the vocabulary of inference to the
 * one module under `domain/` that declares provenance.
 */
function serialisePointer(pointer: FieldProvenance): unknown {
  return {
    eventId: pointer.eventId,
    recordedAt: pointer.recordedAt,
    provenance: canonicalProvenance(pointer.provenance),
  };
}

function serialiseRelation(relation: Relation): unknown {
  return {
    name: relation.name,
    from: { id: relation.from.id, type: relation.from.type },
    to: { id: relation.to.id, type: relation.to.type },
  };
}
