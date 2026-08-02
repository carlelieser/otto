import type Database from "better-sqlite3";
import type { LogPosition } from "../../domain/events/domain-event.js";
import type { KnowledgeState } from "../../domain/knowledge/projected-state.js";
import {
  KNOWLEDGE_PROJECTION,
  NOTHING_PROJECTED,
  type Checkpoint,
  type ProjectionStore,
} from "../../ports/projection-store.js";
import { PROJECTION_TABLES, SEARCH_TABLES } from "./projection-tables.js";
import { readKnowledge } from "./read-projection-rows.js";
import {
  indexCaptureRows,
  writeEntityRows,
  writeRedirectRow,
  writeRelationRow,
} from "./write-projection-rows.js";

const SELECT_CHECKPOINT = `
SELECT position, is_rebuilding FROM projection_position WHERE projection_name = ?`;

const UPSERT_CHECKPOINT = `
INSERT INTO projection_position (projection_name, position, is_rebuilding, updated_at)
VALUES (@projection_name, @position, @is_rebuilding, @updated_at)
ON CONFLICT (projection_name) DO UPDATE SET
  position = excluded.position,
  is_rebuilding = excluded.is_rebuilding,
  updated_at = excluded.updated_at`;

/**
 * The projection tables over SQLite: what the worker writes and every read
 * surface reads.
 *
 * Thin, and deliberately so. Translating rows in either direction lives in
 * `write-projection-rows.ts` and `read-projection-rows.ts`, because neither
 * needs this class's clock or its transaction. What is left here is the part
 * that does: batching a write and recording how far it got, in one transaction,
 * so the recorded position can never run ahead of the rows beneath it.
 */
export class SqliteProjectionStore implements ProjectionStore {
  readonly #database: Database.Database;
  readonly #now: () => string;

  constructor(database: Database.Database, now: () => string = () => new Date().toISOString()) {
    this.#database = database;
    this.#now = now;
  }

  /**
   * Writes the entities and relations the batch touched, and nothing else.
   *
   * **Only what changed**, which is a measured decision rather than a
   * micro-optimisation. Writing every entity per batch made a corpus-sized
   * rebuild 29 s against a 215 ms baseline and a 100-event catch-up 1.3 s
   * against a 500 ms bar — the shape `qa.md` §8 diagnoses as the projection
   * model doing too much work per event. The touched set comes from the fold,
   * which already knows what it wrote.
   */
  /**
   * Merges are applied **after** the entity writes, and that order is
   * load-bearing.
   *
   * A batch holding both an entity's creation and its merging away touches it
   * twice: once as an entity to write and once as an id to remove. Writing the
   * rows first and then removing them leaves the projection saying what the log
   * says. The reverse order would delete the row and then re-insert it, which is
   * a merged-away entity reappearing in every list view — visible only for logs
   * where a merge lands in the same batch as its loser's last change.
   */
  async write(state: KnowledgeState, position: LogPosition): Promise<void> {
    this.#database.transaction(() => {
      for (const id of state.touched.entities) this.#writeEntity(state, id);
      for (const key of state.touched.relations) this.#writeRelation(state, key);
      for (const id of state.touched.merged) this.#writeRedirect(state, id);
      this.#recordPosition(position, false);
    })();
  }

  #writeRedirect(state: KnowledgeState, mergedId: string): void {
    const survivorId = state.redirects.get(mergedId);
    if (survivorId !== undefined) writeRedirectRow(this.#database, mergedId, survivorId);
  }

  #writeEntity(state: KnowledgeState, id: string): void {
    const entity = state.entities.get(id);
    if (entity === undefined) return;
    writeEntityRows(this.#database, entity, state.provenance.get(id) ?? new Map());
  }

  #writeRelation(state: KnowledgeState, key: string): void {
    const relation = state.relations.get(key);
    if (relation !== undefined) writeRelationRow(this.#database, relation);
  }

  async read(): Promise<KnowledgeState> {
    return readKnowledge(this.#database);
  }

  async reset(): Promise<void> {
    this.#database.transaction(() => {
      for (const table of [...PROJECTION_TABLES, ...SEARCH_TABLES]) {
        this.#database.prepare(`DELETE FROM ${table}`).run();
      }
    })();
  }

  async reindexCaptures(): Promise<void> {
    this.#database.transaction(() => indexCaptureRows(this.#database))();
  }

  async checkpoint(): Promise<Checkpoint> {
    const row = this.#database.prepare(SELECT_CHECKPOINT).get(KNOWLEDGE_PROJECTION) as
      { position: number; is_rebuilding: number } | undefined;
    if (row === undefined) return NOTHING_PROJECTED;
    return { position: row.position, isRebuilding: row.is_rebuilding === 1 };
  }

  async beginRebuild(): Promise<void> {
    this.#recordPosition(0, true);
  }

  async finishRebuild(position: LogPosition): Promise<void> {
    this.#recordPosition(position, false);
  }

  #recordPosition(position: LogPosition, isRebuilding: boolean): void {
    this.#database.prepare(UPSERT_CHECKPOINT).run({
      projection_name: KNOWLEDGE_PROJECTION,
      position,
      is_rebuilding: isRebuilding ? 1 : 0,
      updated_at: this.#now(),
    });
  }
}
