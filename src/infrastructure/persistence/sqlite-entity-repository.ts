import type Database from "better-sqlite3";
import type { Entity } from "../../domain/knowledge/entity.js";
import type { Relation } from "../../domain/knowledge/relation.js";
import type { EntityType } from "../../domain/schema/entity-schema.js";
import { nameSimilarity, normaliseName } from "../../inference/resolution/name-similarity.js";
import type {
  EmbeddingQuery,
  EntityRepository,
  ScoredEntity,
} from "../../ports/entity-repository.js";
import {
  type EntityRow,
  type RelationRow,
  toEntity,
  toEntityParameters,
  toRelation,
  toRelationParameters,
} from "./entity-row.js";
import { cosineDistance, fromBlob, toBlob } from "./vector-distance.js";

const SELECT_BY_ID = `SELECT * FROM projection_entities WHERE entity_id = ?`;

/**
 * A name match against the entity's own name or any of its aliases.
 *
 * `LOWER` on both sides rather than `COLLATE NOCASE`, because SQLite's
 * case-insensitive collation folds ASCII only and a name is exactly where a
 * non-ASCII character is likely to appear.
 */
const SELECT_BY_EXACT_NAME = `
SELECT DISTINCT entities.* FROM projection_entities AS entities
LEFT JOIN projection_aliases AS aliases ON aliases.entity_id = entities.entity_id
WHERE entities.entity_type = @type
  AND (LOWER(entities.name) = @name OR LOWER(aliases.alias) = @name)`;

const SELECT_BY_TYPE = `SELECT * FROM projection_entities WHERE entity_type = ?`;

const SELECT_RELATIONS = `
SELECT * FROM projection_relations WHERE from_id = @id OR to_id = @id`;

const SELECT_EMBEDDINGS = `
SELECT embeddings.entity_id, embeddings.embedding, entities.*
FROM projection_embeddings AS embeddings
JOIN projection_entities AS entities ON entities.entity_id = embeddings.entity_id
WHERE embeddings.entity_type = ?`;

const UPSERT_ENTITY = `
INSERT INTO projection_entities (entity_id, entity_type, fields, name, version)
VALUES (@entity_id, @entity_type, @fields, @name, @version)
ON CONFLICT (entity_id) DO UPDATE SET
  entity_type = excluded.entity_type,
  fields = excluded.fields,
  name = excluded.name,
  version = excluded.version`;

const DELETE_ALIASES = `DELETE FROM projection_aliases WHERE entity_id = ?`;

const INSERT_ALIAS = `
INSERT INTO projection_aliases (entity_id, alias) VALUES (?, ?)
ON CONFLICT (entity_id, alias) DO NOTHING`;

const INSERT_RELATION = `
INSERT INTO projection_relations (relation_name, from_id, from_type, to_id, to_type)
VALUES (@relation_name, @from_id, @from_type, @to_id, @to_type)
ON CONFLICT (relation_name, from_id, to_id) DO NOTHING`;

const UPSERT_EMBEDDING = `
INSERT INTO projection_embeddings (entity_id, entity_type, embedding, model_version)
VALUES (@entity_id, @entity_type, @embedding, @model_version)
ON CONFLICT (entity_id) DO UPDATE SET
  embedding = excluded.embedding,
  model_version = excluded.model_version`;

/**
 * How near a fuzzy name match has to be to be worth scoring.
 *
 * Deliberately loose. This is candidate *generation*, whose job is narrowing
 * thousands of entities to a handful, and the scorer is what discriminates
 * afterwards — a tight floor here throws away the candidate the scorer would
 * have rejected anyway *and* the one it would have chosen, and only the second
 * failure is visible. 0.7 admits "Sara Chen" for "Sarah Chen" and excludes
 * unrelated names of similar length.
 */
const FUZZY_FLOOR = 0.7;

/**
 * The entity projection over SQLite: what resolution reads current knowledge
 * through.
 *
 * One adapter, per `add.md` §9 — `:memory:` is the offline mode, so a separate
 * in-memory implementation buys nothing and can silently disagree with the real
 * one, which is the failure Slice 0 had and removed.
 *
 * The write methods are here and are deliberately **not on the port**. The port
 * is read-only from `inference/`'s perspective (§9), which is ADR-0003's rule
 * in its strong form: resolution cannot write because the interface it holds
 * has nothing to write with. These exist for the projection worker, which is
 * `application/`'s, and for tests to arrange a graph to read from.
 */
export class SqliteEntityRepository implements EntityRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  async byId(id: string): Promise<Entity | undefined> {
    const row = this.#database.prepare(SELECT_BY_ID).get(id) as EntityRow | undefined;
    return row === undefined ? undefined : toEntity(row);
  }

  async byExactName(name: string, type: EntityType): Promise<readonly Entity[]> {
    const rows = this.#database
      .prepare(SELECT_BY_EXACT_NAME)
      .all({ name: normaliseName(name), type }) as EntityRow[];
    return rows.map(toEntity);
  }

  /**
   * Scanned in process rather than matched in SQL.
   *
   * SQLite has no edit-distance function without an extension, and the corpus
   * is 3,000 entities — the same size the storage spike measured the vector
   * scan over, and for the same reason: at this volume the scan is arithmetic
   * and the alternative is a dependency.
   */
  async byFuzzyName(name: string, type: EntityType): Promise<readonly Entity[]> {
    const rows = this.#database.prepare(SELECT_BY_TYPE).all(type) as EntityRow[];
    return rows
      .map(toEntity)
      .map((entity) => ({ entity, similarity: similarityTo(name, entity) }))
      .filter(({ similarity }) => similarity >= FUZZY_FLOOR)
      .sort((left, right) => right.similarity - left.similarity)
      .map(({ entity }) => entity);
  }

  /**
   * Exact nearest-neighbour search: every vector of this type scored, the
   * nearest `limit` returned.
   *
   * Exact rather than approximate, and in process rather than through the
   * extension — ADR-0021. The spike cleared the 100 ms bar by 330× and stayed
   * under it at 75,000 entities, so approximate indexing buys nothing Otto
   * needs and the extension carries a licence question a distributed installer
   * has to answer.
   */
  async byNearestEmbedding(query: EmbeddingQuery): Promise<readonly ScoredEntity[]> {
    const rows = this.#database.prepare(SELECT_EMBEDDINGS).all(query.type) as EmbeddingRow[];
    return rows
      .map((row) => ({
        entity: toEntity(row),
        distance: cosineDistance(query.embedding, fromBlob(row.embedding)),
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, query.limit);
  }

  async relationsOf(entityId: string): Promise<readonly Relation[]> {
    const rows = this.#database.prepare(SELECT_RELATIONS).all({ id: entityId }) as RelationRow[];
    return rows.map(toRelation);
  }

  /**
   * Writes an entity and replaces its aliases.
   *
   * Replaced rather than merged because the projection is derived: what an
   * entity's aliases are is whatever the log says they are, and a projection
   * that unions across rebuilds would accumulate aliases the log no longer
   * supports. The "never shrinks" rule in `schema.md` §2 is a rule about the
   * differ, which is what refuses to emit a Command dropping one.
   */
  putEntity(entity: Entity): void {
    this.#database.transaction(() => {
      this.#database.prepare(UPSERT_ENTITY).run(toEntityParameters(entity));
      this.#database.prepare(DELETE_ALIASES).run(entity.id);
      const insert = this.#database.prepare(INSERT_ALIAS);
      for (const alias of entity.fields["aliases"] ?? []) {
        if (typeof alias === "string") insert.run(entity.id, alias);
      }
    })();
  }

  putRelation(relation: Relation): void {
    this.#database.prepare(INSERT_RELATION).run(toRelationParameters(relation));
  }

  putEmbedding(entityId: string, type: EntityType, embedding: EmbeddingRecord): void {
    this.#database.prepare(UPSERT_EMBEDDING).run({
      entity_id: entityId,
      entity_type: type,
      embedding: toBlob(embedding.vector),
      model_version: embedding.modelVersion,
    });
  }
}

/**
 * How alike `name` is to what an entity is called, or 0 when it is called
 * nothing.
 *
 * A nameless entity cannot be fuzzy-matched by name, and reporting 0 rather
 * than throwing keeps a mid-rebuild projection searchable — the alternative is
 * a scan that fails on one malformed row out of 3,000.
 */
function similarityTo(name: string, entity: Entity): number {
  const stored = entity.fields["name"]?.[0];
  return typeof stored === "string" ? nameSimilarity(name, stored) : 0;
}

/** A vector and the model that produced it, recorded together. */
export interface EmbeddingRecord {
  readonly vector: Float32Array;
  /** Which model produced it, so a model change is a rebuild rather than a mix. */
  readonly modelVersion: string;
}

interface EmbeddingRow extends EntityRow {
  readonly embedding: Buffer;
}
