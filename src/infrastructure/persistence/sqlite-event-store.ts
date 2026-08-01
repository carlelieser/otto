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
 * The durable half of the adapter pair, in WAL mode — the case of concurrent
 * readers with a single writer, which is exactly Otto's shape (`stack.md` §3).
 *
 * The driver is `better-sqlite3`, chosen because it can load a binary
 * extension: the vector extension is a `.dylib`/`.so`/`.dll` rather than an npm
 * package (`runtime.md` §4.3), and it lands in Slice 3.
 */
export class SqliteEventStore implements EventStore {
  readonly #database: Database.Database;

  constructor(filename = ":memory:") {
    this.#database = new Database(filename);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("foreign_keys = ON");
    this.#database.exec(CREATE_SCHEMA);
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

  close(): void {
    this.#database.close();
  }
}
