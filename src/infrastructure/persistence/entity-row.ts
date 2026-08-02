import type { Entity, FieldValues } from "../../domain/knowledge/entity.js";
import type { Relation } from "../../domain/knowledge/relation.js";
import type { EntityType } from "../../domain/schema/entity-schema.js";
import type { RelationName } from "../../domain/schema/relation-schema.js";

/** A `projection_entities` row as SQLite returns it. */
export interface EntityRow {
  readonly entity_id: string;
  readonly entity_type: string;
  /** The typed field values as JSON — selected whole, never queried by field. */
  readonly fields: string;
  /** Lifted out of the JSON because candidate generation queries it directly. */
  readonly name: string;
  readonly version: number;
}

/** A `projection_relations` row as SQLite returns it. */
export interface RelationRow {
  readonly relation_name: string;
  readonly from_id: string;
  readonly from_type: string;
  readonly to_id: string;
  readonly to_type: string;
}

/** A row rebuilt into the Entity it was stored from. */
export function toEntity(row: EntityRow): Entity {
  return {
    id: row.entity_id,
    type: row.entity_type as EntityType,
    fields: JSON.parse(row.fields) as Readonly<Record<string, FieldValues>>,
    version: row.version,
  };
}

/** A row rebuilt into the Relation it was stored from. */
export function toRelation(row: RelationRow): Relation {
  return {
    name: row.relation_name as RelationName,
    from: { id: row.from_id, type: row.from_type as EntityType },
    to: { id: row.to_id, type: row.to_type as EntityType },
  };
}

/**
 * The bound parameters an entity insert needs.
 *
 * `name` is written alongside the JSON that also contains it. That is a second
 * copy and it is deliberate: the column exists to be indexed and the JSON
 * exists to be read whole, and the write path here is the only place they can
 * diverge — so it is the only place that has to keep them together.
 */
export function toEntityParameters(entity: Entity): Record<string, unknown> {
  return {
    entity_id: entity.id,
    entity_type: entity.type,
    fields: JSON.stringify(entity.fields),
    name: nameOf(entity),
    version: entity.version,
  };
}

/**
 * An entity's display name, or its id when it has none.
 *
 * A nameless entity is not a case `schema.md` permits — `name` is on every
 * entity type — but a projection rebuilt from a partial log can encounter one
 * mid-rebuild, and a `NOT NULL` column needs something. The id is the honest
 * filler: it never matches a real query and it identifies the row in a way an
 * empty string does not.
 */
function nameOf(entity: Entity): string {
  const [name] = entity.fields["name"] ?? [];
  return typeof name === "string" ? name : entity.id;
}

/** The bound parameters a relation insert needs. */
export function toRelationParameters(relation: Relation): Record<string, unknown> {
  return {
    relation_name: relation.name,
    from_id: relation.from.id,
    from_type: relation.from.type,
    to_id: relation.to.id,
    to_type: relation.to.type,
  };
}
