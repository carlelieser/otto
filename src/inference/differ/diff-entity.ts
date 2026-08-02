import {
  type Entity,
  type EntityValue,
  isSameValue,
  singleValueOf,
  valuesOf,
} from "../../domain/knowledge/entity.js";
import {
  ADD_TO_SET,
  CLEAR_FIELD,
  type ClearFieldPayload,
  SET_FIELD,
  type AddToSetPayload,
  type SetFieldPayload,
} from "../../domain/commands/knowledge-commands.js";
import { type EntityType, findField } from "../../domain/schema/entity-schema.js";
import {
  type DispositionFloor,
  type FieldDefinition,
  isExtractable,
} from "../../domain/schema/field-types.js";
import type { ClaimedValue } from "../../domain/knowledge/claimed-value.js";
import { dependenciesOn, isDependencySatisfied } from "./dependent-fields.js";

/**
 * **The differ.** A deterministic comparison of resolved-and-extracted values
 * against current entity state, producing Commands (`add.md` §5.4).
 *
 * No LLM. That is the whole point: the model emits Mentions and claimed values,
 * and this decides what change they imply. So a Command can never name a field
 * that does not exist or an id that was never real, because nothing that could
 * invent either is in the path that builds one. Hallucination is prevented
 * structurally rather than checked for.
 *
 * **Cardinality, extractability, and per-field floors come from `schema.md`,
 * which is data this reads rather than logic it contains.** A `single` field
 * with a new value supersedes; a `set` field unions and never silently drops a
 * member. Neither rule is written here as a branch on a field name — the branch
 * is on the schema's own `cardinality`, so adding a field to `schema.md` needs
 * no change in this file at all.
 */

/** A change the differ decided on, and the payload it carries. */
export type FieldChange =
  | { readonly type: typeof SET_FIELD; readonly payload: SetFieldPayload }
  | { readonly type: typeof ADD_TO_SET; readonly payload: AddToSetPayload }
  | { readonly type: typeof CLEAR_FIELD; readonly payload: ClearFieldPayload };

/** A claimed value the differ refused, and why. */
export interface RefusedValue {
  readonly field: string;
  readonly reason: RefusalReason;
}

/**
 * The two ways a claimed value is refused here.
 *
 * `derived_field` is the one `qa.md` §7.2 asks for both halves of — the drop
 * *and* the log. `salience` and `last_contact_at` are computed by projection
 * and can never appear in a Proposal, and if the extractor emits one it is
 * dropped and the drop is logged as a schema violation rather than accepted
 * quietly (`schema.md` §1).
 *
 * `unknown_field` should be structurally impossible on this path, since the
 * output schema is generated from `schema.md` and parsing rejects an unknown
 * name before the differ sees it. It is enumerated because "should be
 * impossible" is a claim a test has to be able to make.
 */
export const REFUSAL_REASONS = ["derived_field", "unknown_field"] as const;

export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** What one diff produced: the changes, and what it refused. */
export interface EntityDiff {
  readonly changes: readonly FieldChange[];
  readonly refused: readonly RefusedValue[];
}

/**
 * The changes `claimed` implies against `current`.
 *
 * Returns no changes when the note says nothing new — **a no-op diff produces
 * no Command** (`qa.md` §7.2), which is what stops a re-extraction that
 * confirms current belief from filling the review queue (`runtime.md` §3).
 */
export function diffEntity(current: Entity, claimed: readonly ClaimedValue[]): EntityDiff {
  const changes: FieldChange[] = [];
  const refused: RefusedValue[] = [];

  for (const value of claimed) {
    const accepted = accept(current, value);
    if (accepted.field === null) refused.push(accepted.refusal);
    else changes.push(...changesFor(current, accepted.field, value.value));
  }

  return { changes: [...changes, ...clearedDependents(current, changes)], refused };
}

/**
 * The field definition a claimed value may be applied through, or why it may
 * not be.
 *
 * A discriminated result rather than a nullable field plus a separate check:
 * the two outcomes are exclusive, and returning them as one value is what lets
 * the caller use the definition without asserting it is there.
 */
type Acceptance =
  { readonly field: FieldDefinition } | { readonly field: null; readonly refusal: RefusedValue };

function accept(current: Entity, value: ClaimedValue): Acceptance {
  const field = findField(current.type, value.field);
  if (field === undefined) return refusal(value.field, "unknown_field");
  if (!isExtractable(field)) return refusal(value.field, "derived_field");
  return { field };
}

function refusal(field: string, reason: RefusalReason): Acceptance {
  return { field: null, refusal: { field, reason } };
}

/**
 * The change one claimed value implies, read off the schema's cardinality.
 *
 * The branch is on `cardinality` rather than on a field name, which is what
 * makes this read the schema rather than reimplement it. A `set` field's union
 * is expressed as "add this member if it is not already there" — never as a
 * replacement, so a member cannot be dropped by a Command this function emits.
 */
function changesFor(
  current: Entity,
  field: FieldDefinition,
  value: EntityValue,
): readonly FieldChange[] {
  if (isAlreadyHeld(current, field, value)) return [];
  const payload = { field: field.name, value };
  if (field.cardinality === "set") return [{ type: ADD_TO_SET, payload }];
  return [{ type: SET_FIELD, payload }];
}

/** Whether the entity already holds this value for this field. */
function isAlreadyHeld(current: Entity, field: FieldDefinition, value: EntityValue): boolean {
  if (field.cardinality === "set") {
    return valuesOf(current, field.name).some((held) => isSameValue(held, value));
  }
  const held = singleValueOf(current, field.name);
  return held !== undefined && isSameValue(held, value);
}

/**
 * Fields made stale by the changes just decided on.
 *
 * `schema.md` §4's case: `blocker` is cleared by a status change away from
 * `blocked`. Computed from the changes rather than from the claimed values,
 * because a claim that re-states the current status implies no change and
 * therefore invalidates nothing — a note repeating "still blocked" must not
 * clear the blocker it also repeated.
 */
function clearedDependents(
  current: Entity,
  changes: readonly FieldChange[],
): readonly FieldChange[] {
  return changes.flatMap((change) =>
    change.type === SET_FIELD ? staleAfter(current, change.payload) : [],
  );
}

function staleAfter(current: Entity, payload: SetFieldPayload): readonly FieldChange[] {
  return dependenciesOn(current.type, payload.field)
    .filter((dependency) => !isDependencySatisfied(dependency, payload.value))
    .filter((dependency) => valuesOf(current, dependency.field).length > 0)
    .map((dependency) => ({
      type: CLEAR_FIELD as typeof CLEAR_FIELD,
      payload: { field: dependency.field, because: dependency.dependsOn },
    }));
}

/**
 * The per-field disposition floor, read from `schema.md` rather than decided
 * here.
 *
 * `qa.md` §7.2 asks that floors be read from the schema and not hardcoded in
 * the differ, which is what this being a lookup rather than a table of its own
 * means. What triage *does* with a floor is Slice 5's; the differ's only job is
 * to carry it, so a Proposal arrives at triage already knowing that a rename
 * never auto-applies.
 */
export function floorFor(entityType: EntityType, fieldName: string): DispositionFloor | undefined {
  return findField(entityType, fieldName)?.floor;
}
