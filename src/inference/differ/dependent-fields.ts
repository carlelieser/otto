import type { EntityType } from "../../domain/schema/entity-schema.js";

/**
 * Fields whose value is only meaningful while another field holds a particular
 * value, as data.
 *
 * `schema.md` §4 states one: `blocker` holds *why* a Project is blocked, so a
 * status change away from `blocked` makes it stale rather than merely old.
 * Leaving it would put "waiting on the contract" on an `active` project, which
 * reads as current and is not.
 *
 * A table rather than a branch in the differ, for the reason the schema tables
 * themselves are data: the differ reads cardinality, extractability, and floors
 * from `schema.md` rather than implementing them (`add.md` §5.4), and a
 * dependency expressed as an `if` inside the diff loop is the one rule of the
 * four that would live somewhere else.
 *
 * There is exactly one entry. That is not an argument for hardcoding it — it is
 * the entry that proves the mechanism, and the next one is a row rather than a
 * second branch.
 */

/** A field that goes stale when the field it depends on leaves a set of values. */
export interface Dependency {
  readonly entityType: EntityType;
  /** The field cleared when the dependency no longer holds. */
  readonly field: string;
  /** The field it depends on. */
  readonly dependsOn: string;
  /** The values of `dependsOn` that keep `field` meaningful. */
  readonly whileValueIn: readonly string[];
}

/** `schema.md` §4's dependent fields. */
export const DEPENDENT_FIELDS: readonly Dependency[] = [
  {
    entityType: "Project",
    field: "blocker",
    dependsOn: "status",
    whileValueIn: ["blocked"],
  },
];

/**
 * The dependencies a change to `changedField` on `entityType` may invalidate.
 *
 * Keyed on the field that changed rather than on the field that goes stale,
 * because that is the direction the differ asks in: it has just decided to set
 * `status` and needs to know what that costs.
 */
export function dependenciesOn(
  entityType: EntityType,
  changedField: string,
): readonly Dependency[] {
  return DEPENDENT_FIELDS.filter(
    (dependency) => dependency.entityType === entityType && dependency.dependsOn === changedField,
  );
}

/** Whether `value` keeps the dependent field meaningful. */
export function isDependencySatisfied(dependency: Dependency, value: unknown): boolean {
  return typeof value === "string" && dependency.whileValueIn.includes(value);
}
