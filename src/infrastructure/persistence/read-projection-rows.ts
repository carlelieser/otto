import type Database from "better-sqlite3";
import type { Entity } from "../../domain/knowledge/entity.js";
import {
  nothingTouched,
  relationKey,
  type FieldProvenance,
  type KnowledgeState,
} from "../../domain/knowledge/projected-state.js";
import type { Relation } from "../../domain/knowledge/relation.js";
import { toEntity, toRelation, type EntityRow, type RelationRow } from "./entity-row.js";
import { toFieldProvenance, type ProvenanceRow } from "./provenance-row.js";

const SELECT_ENTITIES = `SELECT * FROM projection_entities`;

const SELECT_PROVENANCE = `SELECT * FROM projection_field_provenance`;

const SELECT_RELATIONS = `SELECT * FROM projection_relations`;

const SELECT_REDIRECTS = `SELECT from_id, to_id FROM projection_redirects`;

/**
 * The projection tables read back into the shape the fold produces.
 *
 * The inverse of what `SqliteProjectionStore` writes, and the round-trip
 * `qa.md` §8's partial-plus-catch-up check exercises: a projection resumed from
 * these rows must equal one folded from event zero, which it can only do if
 * nothing is lost on the way out and back.
 *
 * Functions rather than methods on the store, because none of this needs the
 * store's clock or its transaction — reading rows and rebuilding values is a
 * pure translation, and the store is thinner for not carrying it.
 */
export function readKnowledge(database: Database.Database): KnowledgeState {
  return {
    entities: readEntities(database),
    provenance: readProvenance(database),
    relations: readRelations(database),
    redirects: readRedirects(database),
    // Nothing is pending: every row here is already written, by definition.
    touched: nothingTouched(),
  };
}

/**
 * The redirect table as the one-hop map the fold holds.
 *
 * Read whole rather than queried per id, for the reason provenance is grouped
 * here: resuming a projection is one read, and a chain resolved by walking the
 * table would be a query per hop against a map that is already in memory.
 */
function readRedirects(database: Database.Database): ReadonlyMap<string, string> {
  const rows = database.prepare(SELECT_REDIRECTS).all() as RedirectRow[];
  return new Map(rows.map((row) => [row.from_id, row.to_id]));
}

interface RedirectRow {
  readonly from_id: string;
  readonly to_id: string;
}

function readEntities(database: Database.Database): ReadonlyMap<string, Entity> {
  const rows = database.prepare(SELECT_ENTITIES).all() as EntityRow[];
  return new Map(rows.map((row) => [row.entity_id, toEntity(row)]));
}

/**
 * Provenance rows regrouped per entity.
 *
 * The table is flat because `(entity_id, field)` is its key; the fold holds a
 * map per entity. Grouping here rather than with a query per entity is what
 * keeps resuming a projection one read rather than 3,000.
 */
function readProvenance(
  database: Database.Database,
): ReadonlyMap<string, ReadonlyMap<string, FieldProvenance>> {
  const byEntity = new Map<string, Map<string, FieldProvenance>>();
  for (const row of database.prepare(SELECT_PROVENANCE).all() as ProvenanceRow[]) {
    const pointers = byEntity.get(row.entity_id) ?? new Map<string, FieldProvenance>();
    pointers.set(row.field, toFieldProvenance(row));
    byEntity.set(row.entity_id, pointers);
  }
  return byEntity;
}

function readRelations(database: Database.Database): ReadonlyMap<string, Relation> {
  const rows = database.prepare(SELECT_RELATIONS).all() as RelationRow[];
  return new Map(rows.map(toRelation).map((relation) => [relationKey(relation), relation]));
}
