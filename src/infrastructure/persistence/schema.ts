/** The mutations a table that is truth refuses, and what each trigger is called. */
const REFUSED_MUTATIONS = [
  { operation: "UPDATE", suffix: "are_immutable" },
  { operation: "DELETE", suffix: "are_undeletable" },
] as const;

/**
 * The two tables that are truth (`add.md` §10). Everything else in Otto is a
 * projection: derived, rebuildable from the log alone, and safe to delete.
 *
 * Both are insert-only, and that is enforced twice over. The application layer
 * has no update or delete path, and the triggers below refuse one at the
 * database level — `qa.md` §4.1 asks for both, because a test that the
 * application declines to do something is weaker than a database that will not
 * permit it. A corrupt log is the only unrecoverable failure in the system
 * (`add.md` §11), which is what justifies the belt and braces.
 *
 * `captures` was declared in Slice 0 with its triggers, ahead of the
 * `CaptureStore` port that reads and writes it, because Slice 0's verification
 * asks for the SQLite-level guarantee on *both* truth tables. The
 * repository-level half of that pair arrives with the port in Slice 2; the
 * database-level half could not wait, because a table created without its
 * triggers is a table someone can write an UPDATE against in the meantime.
 *
 * ## The `captures` reshape, and why it is not additive
 *
 * Slice 2 changed this table's shape: Slice 0's single `text` column became
 * `raw_text`, and `corrected_text` and `transcription_model` were added. That
 * is a migration, edited into `CREATE_SCHEMA` in place, and it is worth saying
 * plainly rather than calling it additive.
 *
 * There is no migration mechanism here and Slice 2 does not build one. Because
 * these are `CREATE TABLE IF NOT EXISTS`, an existing database keeps the old
 * shape silently and fails at the first insert against a column that is not
 * there. Any pre-Slice-2 database is disposable — nothing has shipped and no
 * Capture in one is worth keeping — so the migration procedure is: delete the
 * file. A real mechanism arrives when there is a real user's database to
 * protect, which is Slice 11 at the earliest.
 *
 * The three text columns hold three different things and only one is derived.
 * `raw_text` is input, held exactly as it arrived — the transcriber's output
 * verbatim for voice, the keystrokes as submitted for typed, before any of the
 * three normalisation rules ran. `content_hash` is computed over it, so
 * trimming it here would change every id in the system. `corrected_text` is a
 * later human input and stays `NULL` for the whole of Slice 2; declaring it now
 * is what makes Slice 9 an append rather than a second reshape. The normalised
 * form is neither: it is computed on read by a pure function, because a stored
 * copy would be a second truth that can disagree with the first.
 *
 * `transcription_model` records what produced a voice Capture's text — `NULL`
 * for a typed one, and the model name exactly as `whisper.cpp` names it (e.g.
 * `small.en`) for a voice one. It is outside the `capture_id` hash: two
 * recordings of the same audio under different models are the same Capture,
 * because the input did not change, only what read it.
 *
 * `events_by_capture` exists for the startup sweep, which anti-joins `captures`
 * to `events` on `capture_id`. Slice 0 indexed only `(aggregate_id,
 * aggregate_version)`; the sweep is the first query to need this one, and the
 * provenance lookups in Slice 6 walk the same column.
 */
export const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS captures (
  capture_id          TEXT PRIMARY KEY,
  source              TEXT NOT NULL,
  raw_text            TEXT NOT NULL,
  corrected_text      TEXT,
  transcription_model TEXT,
  source_timestamp    TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  ingested_at         TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  position            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id            TEXT NOT NULL UNIQUE,
  type                TEXT NOT NULL,
  version             INTEGER NOT NULL,
  aggregate_type      TEXT NOT NULL,
  aggregate_id        TEXT NOT NULL,
  aggregate_version   INTEGER NOT NULL,
  payload             TEXT NOT NULL,
  proposal_id         TEXT,
  capture_id          TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model_version       TEXT NOT NULL,
  confidence REAL,
  is_human_confirmed  INTEGER NOT NULL,
  recorded_at         TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS events_by_aggregate ON events (aggregate_id, aggregate_version);
CREATE INDEX IF NOT EXISTS events_by_capture ON events (capture_id);

${insertOnlyTriggers("events")}
${insertOnlyTriggers("captures")}
`;

/** Triggers refusing UPDATE and DELETE on a table that is truth. */
function insertOnlyTriggers(table: string): string {
  return REFUSED_MUTATIONS.map(({ operation, suffix }) =>
    refusalTrigger(table, operation, suffix),
  ).join("\n");
}

function refusalTrigger(table: string, operation: string, suffix: string): string {
  return `
CREATE TRIGGER IF NOT EXISTS ${table}_${suffix}
BEFORE ${operation} ON ${table}
BEGIN
  SELECT RAISE(ABORT, '${table} is append-only: ${operation} is not permitted');
END;
`;
}
