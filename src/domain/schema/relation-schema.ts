import type { Cardinality, DispositionFloor } from "./field-types.js";
import { type EntityType, isEntityType } from "./entity-schema.js";

/**
 * `schema.md` §6 as data: the closed vocabulary of named, directed links
 * between two entities.
 *
 * ADR-0010 closed the predicate-vocabulary question for *fields*, but Relations
 * reopen the same problem at the edge level. An open set means Extraction
 * invents relation names and the graph fragments into `works_on`, `working_on`,
 * and `involved_with` meaning one thing. So the set is fixed, small, and typed
 * by the pair of entity types it connects — adding a name is a schema change,
 * the same honest cost ADR-0014 accepted for fields.
 *
 * The type pairs are the half that does real work at runtime. A `knows` between
 * a Person and a Project is not a typo the graph should absorb; it is refused
 * here, before it becomes an edge nothing else would question.
 */

/** The seven relations. A closed set; adding one is a schema change. */
export const RELATION_NAMES = [
  "involves",
  "concerns",
  "attended",
  "relates_to",
  "became",
  "blocks",
  "knows",
] as const;

export type RelationName = (typeof RELATION_NAMES)[number];

/** One from→to pair a relation accepts, both ends typed. */
export interface TypePair {
  readonly from: EntityType;
  readonly to: EntityType;
}

/** A relation name, its accepted type pairs, its cardinality, and its floor. */
export interface RelationDefinition {
  readonly name: RelationName;
  readonly pairs: readonly TypePair[];
  readonly cardinality: Cardinality;
  readonly floor: DispositionFloor;
}

/** `from → to, to, to` as the pairs it denotes, so the tables read like §6. */
function pairs(from: EntityType, ...targets: readonly EntityType[]): readonly TypePair[] {
  return targets.map((to) => ({ from, to }));
}

/**
 * The seven relations with their declared pairs.
 *
 * Transcribed from §6's table, and `tests/domain/relation-schema.test.ts` reads
 * that table to check the transcription — the same arrangement the field tables
 * use, for the same reason: `schema.md` names itself the authority, and an
 * authority nothing checks against is a comment.
 */
export const RELATION_SCHEMA: Readonly<Record<RelationName, RelationDefinition>> = {
  // The most common relation in the graph by a wide margin.
  involves: {
    name: "involves",
    pairs: pairs("Project", "Person"),
    cardinality: "set",
    floor: "auto",
  },
  // What the Task is about. A Task may concern several things.
  concerns: {
    name: "concerns",
    pairs: pairs("Task", "Person", "Project", "Idea", "Event"),
    cardinality: "set",
    floor: "auto",
  },
  attended: {
    name: "attended",
    pairs: pairs("Event", "Person"),
    cardinality: "set",
    floor: "auto",
  },
  /**
   * The deliberate catch-all, and the one to watch: if it dominates the graph,
   * the vocabulary is too small and needs a named addition. That is a reported
   * metric rather than a failing test (`qa.md` §7.3) — see `relation-metrics.ts`.
   */
  relates_to: {
    name: "relates_to",
    pairs: [...pairs("Project", "Project"), ...pairs("Idea", "Idea", "Project")],
    cardinality: "set",
    floor: "auto",
  },
  /**
   * Records promotion, paired with `status: promoted` on the Idea.
   *
   * The one `single` relation, and the one carrying a `review` floor: it is a
   * supersession of one entity by another and sits closer to merge than to an
   * ordinary edge (§6).
   */
  became: {
    name: "became",
    pairs: pairs("Idea", "Project", "Task"),
    cardinality: "single",
    floor: "review",
  },
  blocks: {
    name: "blocks",
    pairs: [...pairs("Task", "Task"), ...pairs("Project", "Project"), ...pairs("Task", "Project")],
    cardinality: "set",
    floor: "auto",
  },
  /**
   * Two people in the user's life who know each other.
   *
   * **Only recorded when a note says so, never inferred from co-occurrence**,
   * which would fill the graph with noise (§6). The scorer uses co-occurrence as
   * a resolution feature, and the temptation to let that feature also write an
   * edge is exactly the bug — `resolution-features.ts` reads co-occurrence and
   * emits nothing.
   */
  knows: {
    name: "knows",
    pairs: pairs("Person", "Person"),
    cardinality: "set",
    floor: "auto",
  },
};

/** The definition of `name`. Total, because `RelationName` is closed. */
export function findRelation(name: RelationName): RelationDefinition {
  return RELATION_SCHEMA[name];
}

/** Whether `value` names one of the seven relations. */
export function isRelationName(value: unknown): value is RelationName {
  return RELATION_NAMES.includes(value as RelationName);
}

/** A proposed edge, before the vocabulary has been asked whether it is legal. */
export interface ProposedRelation {
  readonly name: RelationName;
  readonly from: EntityType;
  readonly to: EntityType;
}

/**
 * Why a proposed relation is not well-formed, or empty if it is.
 *
 * Three ways an edge fails: a name outside the vocabulary, an end that is not
 * one of the five entity types, and a type pair the relation does not accept.
 * The third is the one §6 exists for, and `knows` between a Person and a
 * Project is its worked example.
 */
export function relationViolations(relation: ProposedRelation): readonly string[] {
  const { name, from, to } = relation;
  if (!isRelationName(name)) return [`unknown relation: ${String(name)}`];
  if (!isEntityType(from) || !isEntityType(to)) {
    return [`unknown entity type in ${name}: ${String(from)}→${String(to)}`];
  }
  return isDeclaredPair(name, from, to) ? [] : [`${name} does not accept ${from}→${to}`];
}

function isDeclaredPair(name: RelationName, from: EntityType, to: EntityType): boolean {
  return RELATION_SCHEMA[name].pairs.some((pair) => pair.from === from && pair.to === to);
}
