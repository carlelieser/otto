import type Database from "better-sqlite3";
import { CAPTURE_INGESTED } from "../../domain/events/capture-ingested.js";
import type { Capture, CaptureStore } from "../../ports/capture-store.js";
import { type CaptureRow, toCapture, toInsertParameters } from "./capture-row.js";

const INSERT_CAPTURE = `
INSERT INTO captures (
  capture_id, source, raw_text, corrected_text, transcription_model,
  source_timestamp, content_hash, ingested_at
) VALUES (
  @capture_id, @source, @raw_text, @corrected_text, @transcription_model,
  @source_timestamp, @content_hash, @ingested_at
)
ON CONFLICT (capture_id) DO NOTHING`;

const SELECT_BY_CAPTURE_ID = `SELECT * FROM captures WHERE capture_id = ?`;

/**
 * The startup sweep's anti-join.
 *
 * Filtered to `CaptureIngested` rather than to any event: a Capture with some
 * other event but no ingestion event is still unrecovered, and an unfiltered
 * anti-join would miss it once Slice 9 gives Captures a second event type.
 * `events_by_capture` is the index this walks.
 */
const SELECT_WITHOUT_INGESTION_EVENT = `
SELECT captures.* FROM captures
LEFT JOIN events
  ON events.capture_id = captures.capture_id AND events.type = ?
WHERE events.event_id IS NULL
ORDER BY captures.ingested_at`;

/**
 * The durable half of the Capture store, sharing a connection with the event
 * store because the sweep's anti-join reads both tables.
 *
 * One adapter, per `add.md` §9: `:memory:` is the offline mode for a storage
 * port, and a second in-memory implementation is what Slice 0 removed after its
 * fake and its real adapter silently disagreed about whether a stored record
 * could be edited in place. The rule about in-memory fakes still holds for the
 * ports that reach a model, where there is nothing to stand in for the real
 * thing.
 */
export class SqliteCaptureStore implements CaptureStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  /**
   * `ON CONFLICT DO NOTHING` makes a repeated insert a no-op, so re-read to
   * return what is stored — which is the first Capture, not this one.
   *
   * A second delivery of the same input therefore gets back the Capture the
   * first delivery stored, and nothing is overwritten.
   */
  async put(capture: Capture): Promise<Capture> {
    this.#database.prepare(INSERT_CAPTURE).run(toInsertParameters(capture));
    const stored = await this.get(capture.captureId);
    if (stored === null) {
      throw new Error(`Capture ${capture.captureId} vanished immediately after being stored`);
    }
    return stored;
  }

  async get(captureId: string): Promise<Capture | null> {
    const row = this.#database.prepare(SELECT_BY_CAPTURE_ID).get(captureId) as
      CaptureRow | undefined;
    return row === undefined ? null : toCapture(row);
  }

  async withoutIngestionEvent(): Promise<readonly Capture[]> {
    const rows = this.#database
      .prepare(SELECT_WITHOUT_INGESTION_EVENT)
      .all(CAPTURE_INGESTED) as CaptureRow[];
    return rows.map(toCapture);
  }
}
