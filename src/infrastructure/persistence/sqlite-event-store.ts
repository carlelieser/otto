import Database from "better-sqlite3";
import type { DomainEvent, LogPosition, StoredEvent } from "../../domain/events/domain-event.js";
import type { EventStore } from "../../ports/event-store.js";
import { type EventRow, toInsertParameters, toStoredEvent } from "./event-row.js";
import { rejectIfMalformed } from "./reject-if-malformed.js";
import { CREATE_SCHEMA } from "./schema.js";

const INSERT_EVENT = `
INSERT INTO events (
  event_id, type, version, aggregate_type, aggregate_id, aggregate_version,
  payload, proposal_id, capture_id, provider, model_version,
  confidence, is_human_confirmed, recorded_at
) VALUES (
  @event_id, @type, @version, @aggregate_type, @aggregate_id, @aggregate_version,
  @payload, @proposal_id, @capture_id, @provider, @model_version,
  @confidence, @is_human_confirmed, @recorded_at
)
ON CONFLICT (event_id) DO NOTHING`;

const SELECT_BY_EVENT_ID = `SELECT * FROM events WHERE event_id = ?`;
const SELECT_FORWARD = `SELECT * FROM events WHERE position > ? ORDER BY position LIMIT ?`;
const SELECT_CURRENT_VERSION = `
SELECT MAX(aggregate_version) + 1 AS version FROM events WHERE aggregate_id = ?`;

/** Reading the whole log; SQLite treats a negative LIMIT as unbounded. */
const NO_LIMIT = -1;

/**
 * The log's adapter, in WAL mode — the case of concurrent readers with a single
 * writer, which is exactly Otto's shape (`stack.md` §3).
 *
 * It takes a connection rather than opening one, because `SqliteCaptureStore`
 * shares it: the startup sweep anti-joins `captures` to `events`, which one
 * connection can do and two handles on the same file cannot. `openDatabase`
 * owns the pragmas and the schema.
 */
export class SqliteEventStore implements EventStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  /**
   * The connection, for the sibling store that shares it.
   *
   * `CaptureStore`'s sweep anti-joins `captures` to `events`, which one
   * connection can do and two cannot — a cross-database join is not available
   * to two separate handles on the same file, and would be a second writer
   * besides (`runtime.md` §1 keeps exactly one).
   */
  get database(): Database.Database {
    return this.#database;
  }

  async append(events: readonly DomainEvent[]): Promise<readonly StoredEvent[]> {
    const validated = events.map(rejectIfMalformed);
    const appendAll = this.#database.transaction((batch: readonly DomainEvent[]) =>
      batch.map((event) => this.#appendOne(event)),
    );
    return appendAll(validated);
  }

  /** `ON CONFLICT DO NOTHING` makes a repeated append a no-op, so re-read to return it. */
  #appendOne(event: DomainEvent): StoredEvent {
    this.#database.prepare(INSERT_EVENT).run(toInsertParameters(event));
    const row = this.#database.prepare(SELECT_BY_EVENT_ID).get(event.eventId) as EventRow;
    return toStoredEvent(row);
  }

  async readForward(position: LogPosition, limit?: number): Promise<readonly StoredEvent[]> {
    const rows = this.#database
      .prepare(SELECT_FORWARD)
      .all(position, limit ?? NO_LIMIT) as EventRow[];
    return rows.map(toStoredEvent);
  }

  async currentVersion(aggregateId: string): Promise<number> {
    const row = this.#database.prepare(SELECT_CURRENT_VERSION).get(aggregateId) as {
      version: number | null;
    };
    return row.version ?? 0;
  }
}
