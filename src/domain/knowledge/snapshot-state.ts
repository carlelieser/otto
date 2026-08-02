import type { Entity, FieldValues } from "./entity.js";
import type { Relation } from "./relation.js";
import {
  nothingTouched,
  relationKey,
  type FieldProvenance,
  type KnowledgeState,
} from "./projected-state.js";

/**
 * A projection as something a snapshot can hold, and read back.
 *
 * Separate from `serialiseKnowledge`, which produces a comparison key: that one
 * only has to be stable between two runs in one process, and is free to sort
 * and flatten however compares cleanest. This one has to survive a round-trip
 * through a `SnapshotStore` that may write to disk, so it keeps the shapes
 * whole and `Map` — which does not survive JSON — becomes an array of pairs.
 *
 * The two exist rather than one because merging them would force the
 * comparison key to be parseable, which is a constraint it does not need and
 * which would make it a storage format nothing may change freely.
 */
export interface SnapshotState {
  readonly entities: readonly [string, SnapshotEntity][];
  readonly provenance: readonly [string, readonly [string, FieldProvenance][]][];
  readonly relations: readonly Relation[];
  /**
   * The redirect chain, as pairs.
   *
   * Optional on the way in because a snapshot written before merge shipped has
   * no such key, and a rebuild resuming from one must not be refused — the
   * events after it will rebuild the redirects the log holds. Absent means "no
   * merges yet", which is what a pre-merge snapshot in fact recorded.
   */
  readonly redirects?: readonly [string, string][];
}

/** An entity without its id, which is the key it is stored under. */
interface SnapshotEntity {
  readonly type: string;
  readonly fields: Readonly<Record<string, FieldValues>>;
  readonly version: number;
}

/** The folded state in a shape a snapshot store can keep. */
export function toSnapshotState(state: KnowledgeState): SnapshotState {
  return {
    entities: [...state.entities].map(([id, entity]) => [id, withoutId(entity)]),
    provenance: [...state.provenance].map(([id, pointers]) => [id, [...pointers]]),
    relations: [...state.relations.values()],
    redirects: [...state.redirects],
  };
}

function withoutId(entity: Entity): SnapshotEntity {
  return { type: entity.type, fields: entity.fields, version: entity.version };
}

/**
 * A snapshot read back into the state the fold works on, or `undefined` when it
 * is not one.
 *
 * Returning `undefined` rather than throwing, because a corrupt or stale
 * snapshot is recoverable by deleting it and replaying fully (`add.md` §6) —
 * the caller's response is to discard and rebuild, and an exception would make
 * that the exceptional path rather than the ordinary one.
 */
export function fromSnapshotState(value: unknown): KnowledgeState | undefined {
  if (!isSnapshotState(value)) return undefined;
  return {
    entities: new Map(
      value.entities.map(([id, entity]) => [id, { id, ...entity }] as [string, Entity]),
    ),
    provenance: new Map(value.provenance.map(([id, pointers]) => [id, new Map(pointers)])),
    relations: new Map(value.relations.map((relation) => [relationKey(relation), relation])),
    redirects: new Map(value.redirects ?? []),
    touched: nothingTouched(),
  };
}

/**
 * Whether a value has the shape a snapshot was written with.
 *
 * Shallow: it checks the three collections are arrays, not that every entity
 * inside is well-formed. A snapshot is written by this process from state this
 * process folded, so the failure being guarded against is a truncated or
 * foreign file rather than a subtly wrong one — and a deep check would be a
 * second declaration of every shape in the projection.
 */
function isSnapshotState(value: unknown): value is SnapshotState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SnapshotState>;
  return (
    Array.isArray(candidate.entities) &&
    Array.isArray(candidate.provenance) &&
    Array.isArray(candidate.relations)
  );
}
