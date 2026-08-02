import type { Relation } from "../../domain/knowledge/relation.js";
import { RELATE, type RelatePayload } from "../../domain/commands/knowledge-commands.js";
import { relationViolations } from "../../domain/schema/relation-schema.js";
import { relationInstanceViolations } from "../../domain/knowledge/relation.js";

/**
 * Claimed relations against current ones, producing `Relate` Commands
 * (`add.md` §5.4 — "create this Person, set this Project's status, **relate
 * these two**").
 *
 * The same deterministic comparison the field differ does, with the closed
 * vocabulary standing where the field schema stands. Cardinality comes from
 * `schema.md` §6 rather than from a branch here: `became` is `single` and
 * supersedes, the other six are `set` and union.
 *
 * ## Both ends are resolved before this runs
 *
 * A claimed relation names two Mentions; this takes two entity ids. Resolution
 * happens first and a relation whose ends did not both resolve is not proposed
 * at all — an edge to an entity Otto is not sure about is the same
 * misattribution ADR-0009 refuses at the field level, and it is worse here
 * because an edge asserts something about two entities rather than one.
 *
 * ## `knows` is never inferred
 *
 * Nothing in this file reads co-occurrence, and that is the point. The scorer
 * uses co-occurrence as a *resolution* feature (`scoring.ts`), and the tempting
 * bug `schema.md` §6 names is letting that same signal write a `knows` edge —
 * two people appearing in one note is not two people knowing each other, and
 * inferring it would fill the graph with noise. A relation reaches this
 * function only because a note claimed it.
 */

/** A relation a note claimed, with both ends already resolved to real entities. */
export type ClaimedRelation = Relation;

/** A relation change the differ decided on. */
export interface RelationChange {
  readonly type: typeof RELATE;
  readonly payload: RelatePayload;
}

/** A claimed relation the differ refused, and why. */
export interface RefusedRelation {
  readonly relation: string;
  readonly reason: string;
}

/** What one relation diff produced. */
export interface RelationDiff {
  readonly changes: readonly RelationChange[];
  readonly refused: readonly RefusedRelation[];
}

/**
 * The `Relate` Commands `claimed` implies against `current`.
 *
 * Produces nothing when the note claims only edges that already exist — the
 * same no-op rule the field differ follows, and what stops a re-extraction from
 * re-proposing a graph Otto already has.
 */
export function diffRelations(
  claimed: readonly ClaimedRelation[],
  current: readonly Relation[],
): RelationDiff {
  const changes: RelationChange[] = [];
  const refused: RefusedRelation[] = [];

  for (const relation of claimed) {
    const violation = firstViolation(relation);
    if (violation !== undefined) {
      refused.push({ relation: describe(relation), reason: violation });
      continue;
    }
    if (!isAlreadyHeld(relation, current)) changes.push(toCommand(relation));
  }

  return { changes, refused };
}

/** Why this claimed relation cannot be accepted, or `undefined` if it can. */
function firstViolation(relation: ClaimedRelation): string | undefined {
  const { name, from, to } = relation;
  const vocabulary = relationViolations({ name, from: from.type, to: to.type });
  if (vocabulary.length > 0) return vocabulary[0];
  return relationInstanceViolations(relation)[0];
}

/**
 * Whether the graph already holds this claim.
 *
 * The same edge from the same source to the same target, whatever the
 * cardinality — a claim Otto already holds is a no-op either way. Cardinality
 * does not change *this* question; it changes what the executor does with the
 * Command that results, which is why it is not branched on here.
 *
 * A `single` relation pointing somewhere new is therefore a change rather than
 * a no-op: `became` naming a different target supersedes, and the Command says
 * so by naming the new target. The supersession itself is the executor's, in
 * the same way `SetField` on a `single` field is.
 */
function isAlreadyHeld(relation: ClaimedRelation, current: readonly Relation[]): boolean {
  return current.some((edge) => isSameEdge(edge, relation));
}

function isSameEdge(edge: Relation, relation: ClaimedRelation): boolean {
  const isSameEnds = edge.from.id === relation.from.id && edge.to.id === relation.to.id;
  return edge.name === relation.name && isSameEnds;
}

function toCommand(relation: ClaimedRelation): RelationChange {
  return { type: RELATE, payload: toPayload(relation) };
}

/** An edge flattened into the payload a Command carries. */
function toPayload({ name, from, to }: ClaimedRelation): RelatePayload {
  return {
    relation: name,
    fromId: from.id,
    fromType: from.type,
    toId: to.id,
    toType: to.type,
  };
}

function describe(relation: ClaimedRelation): string {
  return `${relation.name}: ${relation.from.id}→${relation.to.id}`;
}
