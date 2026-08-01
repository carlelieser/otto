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
 * `captures` is declared here with its triggers, ahead of the `CaptureStore`
 * port that will read and write it, because Slice 0's verification asks for the
 * SQLite-level guarantee on *both* truth tables. The repository-level half of
 * that pair arrives with the port in Slice 1; the database-level half cannot
 * wait, because a table created without its triggers is a table someone can
 * write an UPDATE against in the meantime.
 */
export const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS captures (
  capture_id       TEXT PRIMARY KEY,
  source           TEXT NOT NULL,
  text             TEXT NOT NULL,
  source_timestamp TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  ingested_at      TEXT NOT NULL
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
