import type { EntityType } from "../schema/entity-schema.js";
import type { ResolvedDate } from "../values/resolved-date.js";

/**
 * An entity as Otto currently believes it: typed fields carrying real values
 * (ADR-0010).
 *
 * There is no predicate vocabulary and no assertion table. A Person has an
 * `employer` column holding a string, not a row asserting that a subject has a
 * predicate with an object — which is what makes the read path a select rather
 * than a synthesis (`add.md` §7) and what lets the differ ask the schema
 * whether a field replaces or accumulates.
 *
 * This is the shape the differ compares against, which is why it is a plain
 * record rather than a class with behaviour. Nothing here decides anything: the
 * decisions are the schema's (what a field is) and the differ's (what changed).
 */

/**
 * What one field holds.
 *
 * A `single` field holds one value or none; a `set` field holds however many
 * members it has accumulated. Both shapes are here rather than in two types
 * because the differ reads cardinality from the schema and would otherwise have
 * to know which type it was holding before it could ask.
 */
export type FieldValues = readonly EntityValue[];

/** A value as stored: a date field carries a `ResolvedDate`, everything else a string. */
export type EntityValue = string | ResolvedDate;

/**
 * An entity's current state.
 *
 * `version` is what a Command's `expectedVersion` is checked against at apply
 * time (`add.md` §5.6). A Proposal that sat in the review queue for three days
 * while its target changed underneath it fails that check rather than applying
 * blindly, and the version it was computed against is stamped on the Proposal
 * at the moment the differ runs.
 */
export interface Entity {
  readonly id: string;
  readonly type: EntityType;
  /**
   * Every field with a value, keyed by field name. A field absent from this map
   * has no value, which is a different thing from holding an empty one — the
   * differ treats the first as "nothing to supersede" and would treat the
   * second as a value to compare against.
   */
  readonly fields: Readonly<Record<string, FieldValues>>;
  readonly version: number;
}

/**
 * The values `entity` holds for `fieldName`, empty when it holds none.
 *
 * Empty rather than `undefined` because every caller wants to iterate it, and a
 * caller that has to check for absence first is a caller that will forget.
 */
export function valuesOf(entity: Entity, fieldName: string): FieldValues {
  return entity.fields[fieldName] ?? [];
}

/** The one value a `single` field holds, or `undefined` when it holds none. */
export function singleValueOf(entity: Entity, fieldName: string): EntityValue | undefined {
  return valuesOf(entity, fieldName)[0];
}

/**
 * Whether two stored values are the same.
 *
 * A date compares on its timestamp *and* its precision, because "sometime next
 * quarter" and "on the 4th" can resolve to the same instant and are not the
 * same value (`schema.md` §8). Comparing on the timestamp alone would make a
 * precision correction a no-op the differ silently drops.
 *
 * The phrase is deliberately not compared: it is what the note said, and two
 * notes saying "Tuesday" and "next Tuesday" about one instant at one precision
 * are claiming the same thing.
 */
export function isSameValue(left: EntityValue, right: EntityValue): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return left.timestamp === right.timestamp && left.precision === right.precision;
}
