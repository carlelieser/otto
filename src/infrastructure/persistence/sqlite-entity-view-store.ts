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

const SEARCH_ENTITIES = `
SELECT entity_id, entity_type FROM projection_entity_search
WHERE projection_entity_search MATCH ? ORDER BY rank LIMIT ?`;

const SEARCH_CAPTURES = `
SELECT capture_id, text FROM projection_capture_search
WHERE projection_capture_search MATCH ? ORDER BY rank LIMIT ?`;

const CLEAR_CAPTURE_INDEX = `DELETE FROM projection_capture_search`;

/**
 * Captures indexed from the table that is truth rather than from the log.
 *
 * A Capture's text is not in any event — `CaptureIngested` carries the id and
 * the hash — so this projection is built from `captures` directly. That is a
 * projection of truth rather than of the log, which the `projection_` prefix
 * still describes accurately: it is derived, droppable, and rebuildable from a
 * table that cannot lose rows.
 */
const SELECT_CAPTURE_TEXT = `
SELECT capture_id, COALESCE(corrected_text, raw_text) AS text FROM captures`;

const INSERT_CAPTURE_INDEX = `
INSERT INTO projection_capture_search (capture_id, text) VALUES (?, ?)`;

/**
 * The read surfaces the dashboard queries (`add.md` §7).
 *
 * Reads only, and the absence of a write method is the same structural
 * narrowing `EntityRepository` uses: what the UI cannot do to the projection is
 * an interface with nothing on it to do, rather than a rule someone remembers.
 * The one exception is `indexCaptures`, which is projection work rather than a
 * UI operation — see its own comment.
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
    const row = this.#database.prepare(SELECT_ENTITY).get(id) as EntityRow | undefined;
    if (row === undefined) return undefined;
    return {
      entity: toEntity(row),
      relations: this.#relationsOf(id),
      provenance: this.#provenanceOf(id),
    };
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

  /**
   * Rebuilds the Capture search index from the `captures` table.
   *
   * A write method on a read adapter, which is worth justifying rather than
   * hiding: the entity index is maintained by the projection worker as it folds
   * events, but Capture text never appears in an event, so there is nothing for
   * the worker to fold. The index is rebuilt wholesale instead — cheap at
   * 10,000 Captures, and it keeps the alternative off the table, which would be
   * a trigger on `captures` tying a projection to the write path.
   */
  async indexCaptures(): Promise<void> {
    this.#database.transaction(() => {
      this.#database.prepare(CLEAR_CAPTURE_INDEX).run();
      const insert = this.#database.prepare(INSERT_CAPTURE_INDEX);
      for (const row of this.#database.prepare(SELECT_CAPTURE_TEXT).all() as CaptureTextRow[]) {
        insert.run(row.capture_id, row.text);
      }
    })();
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

interface CaptureTextRow {
  readonly capture_id: string;
  readonly text: string;
}
