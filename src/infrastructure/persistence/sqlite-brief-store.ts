import type Database from "better-sqlite3";
import type { BriefKind, BriefSelection } from "../../inference/salience/brief-selection.js";
import {
  DEFAULT_BRIEF_LIMIT,
  type AttentionSignal,
  type BriefStore,
  type BriefWriteResult,
  type EntityOpen,
  type StoredBrief,
} from "../../ports/brief-store.js";

/**
 * Where briefs live, and where the instrumentation that replaces v0 accumulates
 * (`salience.md` §4, §5).
 *
 * **Insert-or-nothing, never insert-or-replace.** A brief is a record of what
 * mattered on a day, and `ON CONFLICT DO NOTHING` is what makes "not
 * regenerated once written" a property of the statement rather than a rule a
 * caller must know. The row is read back afterwards so the caller receives what
 * is actually stored rather than what it hoped to store.
 */
export class SqliteBriefStore implements BriefStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  async put(brief: StoredBrief): Promise<BriefWriteResult> {
    const inserted = this.#insert(brief);
    const stored = await this.byId(brief.briefId);
    return { brief: stored ?? brief, wasStored: inserted };
  }

  /** The brief and its entity rows in one transaction, or neither. */
  #insert(brief: StoredBrief): boolean {
    const write = this.#database.transaction((subject: StoredBrief) => {
      const result = this.#database.prepare(INSERT_BRIEF).run(toBriefParameters(subject));
      if (result.changes === 0) return false;
      this.#insertEntities(subject);
      return true;
    });
    return write(brief);
  }

  #insertEntities(brief: StoredBrief): void {
    const insert = this.#database.prepare(INSERT_BRIEF_ENTITY);
    for (const section of brief.selection.sections) {
      for (const entity of section.entities) {
        insert.run(brief.briefId, entity.entityId, section.heading, entity.salience.score);
      }
    }
  }

  async recent(
    kind: BriefKind,
    limit: number = DEFAULT_BRIEF_LIMIT,
  ): Promise<readonly StoredBrief[]> {
    const rows = this.#database.prepare(SELECT_RECENT).all(kind, limit) as BriefRow[];
    return rows.map(toStoredBrief);
  }

  async byId(briefId: string): Promise<StoredBrief | undefined> {
    const row = this.#database.prepare(SELECT_BY_ID).get(briefId) as BriefRow | undefined;
    return row === undefined ? undefined : toStoredBrief(row);
  }

  async unreadCount(): Promise<number> {
    const row = this.#database.prepare(COUNT_UNREAD).get() as { count: number };
    return row.count;
  }

  async markRead(briefId: string, readAt: string): Promise<void> {
    this.#database.prepare(MARK_READ).run(readAt, briefId);
  }

  async recordEntityOpened(open: EntityOpen): Promise<void> {
    this.#database
      .prepare(INSERT_OPEN)
      .run(open.entityId, open.openedAt, open.briefId, open.salience);
  }

  /**
   * The precision and recall counts, as three queries rather than one join.
   *
   * Separate because they answer different questions over different row sets,
   * and a single query producing all three would need two outer joins to say
   * what three `WHERE` clauses say plainly.
   */
  async attention(): Promise<AttentionSignal> {
    const surfaced = this.#count(COUNT_SURFACED);
    const surfacedAndOpened = this.#count(COUNT_SURFACED_AND_OPENED);
    const unsurfaced = this.#database.prepare(UNSURFACED_OPENS).get() as UnsurfacedRow;
    return {
      surfaced,
      surfacedAndOpened,
      openedUnsurfaced: unsurfaced.count,
      meanUnsurfacedSalience: unsurfaced.mean_salience ?? 0,
    };
  }

  #count(sql: string): number {
    return (this.#database.prepare(sql).get() as { count: number }).count;
  }
}

const INSERT_BRIEF = `
INSERT INTO briefs (
  brief_id, kind, covers_from, covers_to, selection,
  prose, provider, model_version, generated_at, read_at
) VALUES (
  @brief_id, @kind, @covers_from, @covers_to, @selection,
  @prose, @provider, @model_version, @generated_at, @read_at
)
ON CONFLICT (brief_id) DO NOTHING`;

const INSERT_BRIEF_ENTITY = `
INSERT INTO brief_entities (brief_id, entity_id, heading, salience)
VALUES (?, ?, ?, ?)
ON CONFLICT (brief_id, entity_id, heading) DO NOTHING`;

const SELECT_BY_ID = `SELECT * FROM briefs WHERE brief_id = ?`;

const SELECT_RECENT = `
SELECT * FROM briefs WHERE kind = ? ORDER BY covers_to DESC, brief_id DESC LIMIT ?`;

const COUNT_UNREAD = `SELECT COUNT(*) AS count FROM briefs WHERE read_at IS NULL`;

const MARK_READ = `UPDATE briefs SET read_at = ? WHERE brief_id = ? AND read_at IS NULL`;

const INSERT_OPEN = `
INSERT INTO brief_entity_opens (entity_id, opened_at, brief_id, salience)
VALUES (?, ?, ?, ?)
ON CONFLICT (entity_id, opened_at) DO NOTHING`;

/** How many distinct entities any brief has surfaced. */
const COUNT_SURFACED = `SELECT COUNT(DISTINCT entity_id) AS count FROM brief_entities`;

/**
 * Surfaced entities the user then opened — the precision signal.
 *
 * Membership is `brief_entities` rather than the open's own `brief_id`, so this
 * count and `COUNT_SURFACED` are over the same set and dividing one by the
 * other means something. An open stamped with a `brief_id` for an entity no
 * brief listed would otherwise push the ratio above 1.
 */
const COUNT_SURFACED_AND_OPENED = `
SELECT COUNT(DISTINCT o.entity_id) AS count
FROM brief_entity_opens o
WHERE EXISTS (SELECT 1 FROM brief_entities e WHERE e.entity_id = o.entity_id)`;

/** Opens of entities no brief surfaced, with their mean salience — the recall signal. */
const UNSURFACED_OPENS = `
SELECT COUNT(*) AS count, AVG(salience) AS mean_salience
FROM brief_entity_opens o
WHERE o.brief_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM brief_entities e WHERE e.entity_id = o.entity_id)`;

/** A `briefs` row as SQLite returns it. */
interface BriefRow {
  readonly brief_id: string;
  readonly kind: string;
  readonly covers_from: string;
  readonly covers_to: string;
  readonly selection: string;
  readonly prose: string;
  readonly provider: string;
  readonly model_version: string;
  readonly generated_at: string;
  readonly read_at: string | null;
}

interface UnsurfacedRow {
  readonly count: number;
  /** `NULL` when no rows matched, which `AVG` returns rather than 0. */
  readonly mean_salience: number | null;
}

function toBriefParameters(brief: StoredBrief): Record<string, unknown> {
  return {
    brief_id: brief.briefId,
    kind: brief.kind,
    covers_from: brief.selection.coversFrom,
    covers_to: brief.selection.coversTo,
    selection: JSON.stringify(brief.selection),
    prose: brief.prose,
    provider: brief.provider,
    model_version: brief.modelVersion,
    generated_at: brief.generatedAt,
    read_at: brief.readAt,
  };
}

function toStoredBrief(row: BriefRow): StoredBrief {
  return {
    briefId: row.brief_id,
    kind: row.kind as BriefKind,
    selection: JSON.parse(row.selection) as BriefSelection,
    prose: row.prose,
    provider: row.provider,
    modelVersion: row.model_version,
    generatedAt: row.generated_at,
    readAt: row.read_at,
  };
}
