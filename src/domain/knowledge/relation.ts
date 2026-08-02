import type { EntityType } from "../schema/entity-schema.js";
import { type RelationName, relationViolations } from "../schema/relation-schema.js";

/**
 * A named, directed, revisable link between two entities as it is stored
 * (`CONTEXT.md`).
 *
 * The vocabulary it draws its name from is closed and typed by the pair of
 * entity types it connects (`schema.md` §6, ADR-0014); this is one edge of that
 * vocabulary, with both ends resolved to real entity ids.
 */
export interface Relation {
  readonly name: RelationName;
  readonly from: EntityEnd;
  readonly to: EntityEnd;
}

/** One end of an edge: which entity, and of what type. */
export interface EntityEnd {
  readonly id: string;
  readonly type: EntityType;
}

/**
 * Why a stored relation is not well-formed, or empty if it is.
 *
 * Delegates the vocabulary question to the schema and adds the one an edge with
 * real ends can fail that a type pair cannot see: an entity related to itself.
 * `blocks` from a Task to the same Task is not a dependency, and `knows`
 * between a Person and themselves is not a fact about the user's life.
 */
export function relationInstanceViolations(relation: Relation): readonly string[] {
  const { name, from, to } = relation;
  const schemaViolations = relationViolations({ name, from: from.type, to: to.type });
  if (schemaViolations.length > 0) return schemaViolations;
  return from.id === to.id ? [`${name}: an entity cannot relate to itself`] : [];
}
