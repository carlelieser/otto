import { findField } from "../schema/entity-schema.js";
import { isSameValue, type Entity, type EntityValue, type FieldValues } from "./entity.js";
import type { FieldProvenance } from "./projected-state.js";

/**
 * **What a merge does to two entities' fields** (ADR-0009, `triage.md` §5).
 *
 * The survivor's value is kept and the loser's moves into `notes`. That rule is
 * what lets a minimal merge ship without the per-fact classification UI the full
 * ADR-0009 affordance calls for: nothing is dropped, so nothing needs deciding,
 * and a wrong survivor choice costs a `notes` line rather than a fact.
 *
 * It is here rather than in `project-entity.ts` because the fold is a dispatch
 * table and this is one branch's whole rule — a reader asking "what happens to a
 * conflicting employer?" should find the answer in a file about merging rather
 * than a third of the way down the file about folding.
 */

/** Where a conflicting value goes. A `set` field, so conflicts accumulate. */
const NOTES = "notes";

/** The two entities a merge combines and the pointers each brought with it. */
export interface MergeSides {
  readonly survivor: Entity;
  readonly loser: Entity;
  readonly survivorPointers: ReadonlyMap<string, FieldProvenance>;
  readonly loserPointers: ReadonlyMap<string, FieldProvenance>;
  /** The merge event, which is what wrote any note the merge produced. */
  readonly mergePointer: MergePointer;
}

/** The survivor as it stands after absorbing the loser, and its pointers. */
export interface MergeOutcome {
  readonly entity: Entity;
  readonly pointers: ReadonlyMap<string, FieldProvenance>;
}

/**
 * The pointer to the merge event itself, for the values the merge created.
 *
 * `notes` is the one field a merge can write that no earlier event set: the
 * loser's conflicting value moved there, and the change that moved it is the
 * merge. Pointing it anywhere else would attribute a line to an event that never
 * said it, and leaving it unpointed would break the property `qa.md` §7.5 states
 * over every field — that none lacks provenance.
 */
export type MergePointer = FieldProvenance;

/**
 * The survivor with every value from both sides, and its version advanced.
 *
 * The version bump is what makes a Proposal computed before the merge fail its
 * check afterwards: the survivor did change, and a Command stamped against the
 * old version is one nobody has re-derived against an entity that has since
 * absorbed another.
 */
export function mergedEntity(sides: MergeSides): MergeOutcome {
  const fields = mergedFields(sides.survivor, sides.loser);
  return {
    entity: { ...sides.survivor, fields, version: sides.survivor.version + 1 },
    pointers: mergedPointers(sides, fields),
  };
}

/** Whether the merge, rather than either side, is what put `notes` where it is. */
function mergeWroteNotes(sides: MergeSides, fields: Entity["fields"]): boolean {
  const before = sides.survivor.fields[NOTES] ?? [];
  return (fields[NOTES]?.length ?? 0) > before.length;
}

/** Every field of both sides, conflicts resolved into `notes`. */
function mergedFields(survivor: Entity, loser: Entity): Entity["fields"] {
  const fields: Record<string, FieldValues> = { ...survivor.fields };
  const notes = [...(survivor.fields[NOTES] ?? [])];
  for (const [field, values] of Object.entries(loser.fields)) {
    if (field === NOTES) appendMembers(notes, values);
    else resolveField(fields, notes, { field, values, type: survivor.type });
  }
  return notes.length === 0 ? fields : { ...fields, [NOTES]: notes };
}

/** One of the loser's fields: adopted, unioned, or noted. */
interface LoserField {
  readonly field: string;
  readonly values: FieldValues;
  /** The survivor's type, which is what the schema is asked about. */
  readonly type: Entity["type"];
}

/**
 * A field the survivor lacks is adopted; one it holds is unioned member by
 * member, and any member it cannot hold becomes a note.
 *
 * The union is what makes a `set` field lossless without a note: `aliases` is
 * the field candidate generation reads, and pushing a merged alias into `notes`
 * would make the merged-away Sarah's alias stop finding the surviving one.
 * A `single` field holds one value, so its second value is the conflict.
 */
function resolveField(
  fields: Record<string, FieldValues>,
  notes: EntityValue[],
  loser: LoserField,
): void {
  const held = fields[loser.field];
  if (held === undefined || held.length === 0) {
    fields[loser.field] = loser.values;
    return;
  }
  fields[loser.field] = accumulates(loser)
    ? unioned(held, loser.values)
    : keepSurvivor(held, notes, loser);
}

/**
 * Whether a field accumulates, **read from the schema rather than inferred from
 * how many values happen to be there**.
 *
 * Counting the survivor's values would answer this correctly except for a `set`
 * field holding exactly one member, which is the common case for `aliases` — and
 * getting it wrong there pushes a merged alias into `notes`, so the merged-away
 * Sarah's alias stops finding the surviving one. Cardinality is declared in
 * `schema.md` and `entity-schema.ts` is that declaration; asking it is what keeps
 * this rule from being a second, quieter answer to the same question.
 *
 * A field the schema does not declare is treated as single-valued, which is the
 * conservative direction: the value goes to `notes` rather than being unioned
 * into a field whose cardinality nothing vouches for.
 */
function accumulates(loser: LoserField): boolean {
  return findField(loser.type, loser.field)?.cardinality === "set";
}

/** The survivor's value, with the loser's recorded in `notes` when it differs. */
function keepSurvivor(held: FieldValues, notes: EntityValue[], loser: LoserField): FieldValues {
  for (const value of loser.values) {
    if (!held.some((kept) => isSameValue(kept, value))) notes.push(noteOf(loser.field, value));
  }
  return held;
}

/** Both sides' members, in the survivor's order, with no member twice. */
function unioned(held: FieldValues, incoming: FieldValues): FieldValues {
  const merged = [...held];
  appendMembers(merged, incoming);
  return merged;
}

function appendMembers(members: EntityValue[], incoming: FieldValues): void {
  for (const value of incoming) {
    if (!members.some((held) => isSameValue(held, value))) members.push(value);
  }
}

/**
 * A conflicting value as a note, naming the field it came from.
 *
 * The field name is carried because a bare "Acme" in `notes` is a value nobody
 * can interpret later — the whole point of moving it rather than dropping it is
 * that a user reading the merged entity can see what was claimed and where.
 */
function noteOf(field: string, value: EntityValue): string {
  return `${field}: ${typeof value === "string" ? value : value.timestamp}`;
}

/**
 * The survivor's pointers, plus the loser's for every field the survivor
 * adopted.
 *
 * A field the survivor already had keeps its own pointer: it kept its value, so
 * the event that set that value is still the one that explains it. A field it
 * gained keeps the loser's pointer, which names an event against an id that no
 * longer appears anywhere — and that is exactly what redirects are for.
 */
function mergedPointers(
  sides: MergeSides,
  fields: Entity["fields"],
): ReadonlyMap<string, FieldProvenance> {
  const pointers = new Map(sides.survivorPointers);
  for (const field of Object.keys(fields)) {
    const adopted = sides.loserPointers.get(field);
    if (!pointers.has(field) && adopted !== undefined) pointers.set(field, adopted);
  }
  if (mergeWroteNotes(sides, fields)) pointers.set(NOTES, sides.mergePointer);
  return pointers;
}
