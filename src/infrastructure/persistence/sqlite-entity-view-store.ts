import type Database from "better-sqlite3";
import type { Entity } from "../../domain/knowledge/entity.js";
import type { FieldProvenance } from "../../domain/knowledge/projected-state.js";
import type { Relation } from "../../domain/knowledge/relation.js";
import type { EntityType } from "../../domain/schema/entity-schema.js";
import {
  DEFAULT_SEARCH_LIMIT,
  type CaptureHit,
  type EntityHit,
  type EntityView,
  type EntityViewStore,
} from "../../ports/entity-view-store.js";
import { toEntity, toRelation, type EntityRow, type RelationRow } from "./entity-row.js";
import { toFieldProvenance, type ProvenanceRow } from "./provenance-row.js";
import { toMatchQuery } from "./fts-query.js";

const SELECT_ENTITY = `SELECT * FROM projection_entities WHERE entity_id = ?`;

const SELECT_BY_TYPE = `
SELECT * FROM projection_entities WHERE entity_type = ? ORDER BY name, entity_id`;

const SELECT_RELATIONS = `
SELECT * FROM projection_relations WHERE from_id = @id OR to_id = @id
ORDER BY relation_name, from_id, to_id`;

const SELECT_PROVENANCE = `SELECT * FROM projection_field_provenance WHERE entity_id = ?`;

const SELECT_REDIRECT = `SELECT to_id FROM projection_redirects WHERE from_id = ?`;

/**
 * How many redirects a chain is followed through before the walk gives up.
 *
 * A bound rather than a loop until exhaustion, because this walks a table rather
 * than a map whose size is known: a cycle from a corrupt row would otherwise
 * hang every read of that id. The fold cannot produce one — a merged-away id is
 * gone, so nothing can merge it again — and a hundred is far past any chain a
 * real history produces.
 */
const MAX_REDIRECT_HOPS = 100;

const SEARCH_ENTITIES = `
SELECT entity_id, entity_type FROM projection_entity_search
WHERE projection_entity_search MATCH ? ORDER BY rank LIMIT ?`;

const SEARCH_CAPTURES = `
SELECT capture_id, text FROM projection_capture_search
WHERE projection_capture_search MATCH ? ORDER BY rank LIMIT ?`;

/**
 * The read surfaces the dashboard queries (`add.md` §7).
 *
 * Reads only, and the absence of a write method is the same structural
 * narrowing `EntityRepository` uses: what the UI cannot do to the projection is
 * an interface with nothing on it to do, rather than a rule someone remembers.
 *
 * Maintaining the indexes it searches is the projection worker's, through
 * `ProjectionStore` — including the Capture index, which is rebuilt from the
 * `captures` table because no event carries a Capture's text.
 */
export class SqliteEntityViewStore implements EntityViewStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  /**
   * An entity, its relations, and its provenance in three queries.
   *
   * Three rather than one join, because a join across relations and provenance
   * multiplies rows — an entity with eight fields and six relations returns
   * forty-eight rows to reassemble in process. Three indexed lookups against a
   * projection is what `add.md` §7 means by "a row and a handful of joins".
   */
  async entityView(id: string): Promise<EntityView | undefined> {
    const resolved = this.resolveId(id);
    const row = this.#database.prepare(SELECT_ENTITY).get(resolved) as EntityRow | undefined;
    if (row === undefined) return undefined;
    return {
      entity: toEntity(row),
      relations: this.#relationsOf(resolved),
      provenance: this.#provenanceOf(resolved),
    };
  }

  /**
   * **The id `id` resolves to, following the redirect chain** (ADR-0009).
   *
   * The two places a merged-away id is still encountered are both reads: a
   * proposal queued before the merge, and provenance display for an event whose
   * target is immutably the old id. Both arrive here, which is why resolution
   * lives on the read path rather than at the moment of merging — nothing had to
   * touch the review queue, and no event was rewritten.
   *
   * Chains rather than one hop: merging #4891 into #4172 and later #4172 into
   * #5310 must resolve #4891 all the way to #5310. A one-hop lookup answers with
   * an id that appears in no list view.
   *
   * An id nothing merged away resolves to itself, so a caller needs no branch.
   */
  resolveId(id: string): string {
    const select = this.#database.prepare(SELECT_REDIRECT);
    let resolved = id;
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
      const row = select.get(resolved) as { to_id: string } | undefined;
      if (row === undefined) return resolved;
      resolved = row.to_id;
    }
    return resolved;
  }

  #relationsOf(id: string): readonly Relation[] {
    const rows = this.#database.prepare(SELECT_RELATIONS).all({ id }) as RelationRow[];
    return rows.map(toRelation);
  }

  #provenanceOf(id: string): ReadonlyMap<string, FieldProvenance> {
    const rows = this.#database.prepare(SELECT_PROVENANCE).all(id) as ProvenanceRow[];
    return new Map(rows.map((row) => [row.field, toFieldProvenance(row)]));
  }

  async entitiesOfType(type: EntityType): Promise<readonly Entity[]> {
    const rows = this.#database.prepare(SELECT_BY_TYPE).all(type) as EntityRow[];
    return rows.map(toEntity);
  }

  async searchCaptures(
    query: string,
    limit = DEFAULT_SEARCH_LIMIT,
  ): Promise<readonly CaptureHit[]> {
    const match = toMatchQuery(query);
    if (match === undefined) return [];
    const rows = this.#database.prepare(SEARCH_CAPTURES).all(match, limit) as CaptureSearchRow[];
    return rows.map((row) => ({ captureId: row.capture_id, text: row.text }));
  }

  async searchEntities(query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<readonly EntityHit[]> {
    const match = toMatchQuery(query);
    if (match === undefined) return [];
    const rows = this.#database.prepare(SEARCH_ENTITIES).all(match, limit) as EntitySearchRow[];
    return rows.map((row) => ({
      entityId: row.entity_id,
      entityType: row.entity_type as EntityType,
    }));
  }
}

interface CaptureSearchRow {
  readonly capture_id: string;
  readonly text: string;
}

interface EntitySearchRow {
  readonly entity_id: string;
  readonly entity_type: string;
}
