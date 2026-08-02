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
 *
 * ## `extraction_proposals` has no immutability triggers, and that is deliberate
 *
 * Slice 3 adds a third table and does *not* make it a third table that is truth.
 * A Proposal is not a change to knowledge — it is a claim awaiting triage, and
 * most never become events at all, since a discarded Proposal is recorded and
 * never applied (`add.md` §5.5). It is derived state: everything in it is
 * reproducible from the Capture and the named model, which is exactly what
 * `runtime.md` §3's id derivation guarantees.
 *
 * So it is rebuildable rather than protected, which is the property that makes
 * re-extraction possible at all. Adding the triggers here would read as
 * consistency and would in fact forbid the scoped re-extraction `runtime.md` §3
 * calls a tool for recovering from a known-bad extraction period.
 *
 * `mention` holds the Mention as JSON rather than as columns. It is read whole
 * by the stage that consumes it and never queried by field, and the alternative
 * — a row per claimed field value — is a schema that has to change every time
 * `schema.md` does, which is the coupling `entity-schema.ts` exists to keep in
 * one place.
 *
 * ## `proposal_dispositions` has no triggers either, and needs a delete path
 *
 * Slice 5 adds triage's decision about each Proposal. It is derived state for
 * the same reason `extraction_proposals` is (ADR-0019) — re-triaging a Proposal
 * against the same thresholds reproduces it — so it carries no immutability
 * triggers.
 *
 * It goes further: this is the first table in Otto that *must* be able to
 * delete. Discards are retained for thirty days and then are not
 * (`triage.md` §7), so triggers here would forbid the window they would look
 * like they were protecting. It is deliberately not `projection_`-prefixed,
 * because it is not rebuildable from the log alone: a discard never becomes an
 * event, so the log has no record of it to rebuild from.
 *
 * `expires_at` is precomputed at write time and `NULL` for anything that is not
 * a discard. The alternative is date arithmetic in the retention query, which
 * would restate a domain rule (`domain/policies/retention.ts`) in SQL where
 * nothing checks it against the original.
 *
 * ## The `projection_` prefix is load-bearing
 *
 * Slice 4 adds the entity projection, and `add.md` §10 asks for exactly this:
 * derived tables in their own namespace, so "is this rebuildable?" is
 * answerable by looking at the name rather than by reading the projection code.
 * Every `projection_` table is droppable and rebuildable from the log alone,
 * and none of them carries an immutability trigger — a table that rebuilds is a
 * table something must be able to delete from.
 *
 * `fields` holds an entity's typed values as JSON for the same reason `mention`
 * does: the alternative is a column per field in `schema.md`, and a schema
 * migration every time a field is added. The read path selects a whole entity
 * (`add.md` §7) rather than querying one field across entities, so nothing
 * needs them as columns. `name` is the exception, lifted out as a real column
 * because candidate generation queries it directly and a JSON extract cannot be
 * indexed usefully.
 *
 * `projection_aliases` is a table rather than a member of the `fields` JSON for
 * the same reason: `aliases` "feeds candidate generation directly"
 * (`schema.md` §2), and the exact-match query is the cheapest and
 * highest-precision of the three candidate sources. It is a projection of the
 * `aliases` field rather than a second truth about it.
 *
 * `projection_embeddings.embedding` is a **`BLOB` in an ordinary table, not a
 * virtual table** (`runtime.md` §4.3). SQLite-Vector 1.0 works this way, which
 * is the one piece of the storage spike's schema that does not transfer as
 * written — the spike used a `sqlite-vec` virtual table and that is a different
 * project. Float32, since quantization trades recall for a resource Otto is not
 * short of at 3,000 entities.
 *
 * ## The tables Slice 6 adds are documented with the list that clears them
 *
 * `projection_field_provenance`, `projection_redirects`, `projection_position`,
 * and the two `fts5` search tables are declared below and explained in
 * `projection-tables.ts`, alongside the list a rebuild empties. Keeping the
 * reasoning next to that list is what makes the two hard to get out of step:
 * a `projection_` table missing from it survives a rebuild and quietly becomes
 * a second truth.
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

CREATE TABLE IF NOT EXISTS extraction_proposals (
  proposal_id         TEXT PRIMARY KEY,
  capture_id          TEXT NOT NULL,
  ordinal             INTEGER NOT NULL,
  mention             TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model_version       TEXT NOT NULL,
  extracted_at        TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS proposal_dispositions (
  proposal_id         TEXT PRIMARY KEY,
  capture_id          TEXT NOT NULL,
  disposition         TEXT NOT NULL,
  confidence          REAL NOT NULL,
  was_sampled         INTEGER NOT NULL,
  decided_at          TEXT NOT NULL,
  expires_at          TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS projection_entities (
  entity_id           TEXT PRIMARY KEY,
  entity_type         TEXT NOT NULL,
  fields              TEXT NOT NULL,
  name                TEXT NOT NULL,
  version             INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projection_aliases (
  entity_id           TEXT NOT NULL,
  alias               TEXT NOT NULL,
  PRIMARY KEY (entity_id, alias)
) STRICT;

CREATE TABLE IF NOT EXISTS projection_relations (
  relation_name       TEXT NOT NULL,
  from_id             TEXT NOT NULL,
  from_type           TEXT NOT NULL,
  to_id               TEXT NOT NULL,
  to_type             TEXT NOT NULL,
  PRIMARY KEY (relation_name, from_id, to_id)
) STRICT;

CREATE TABLE IF NOT EXISTS projection_embeddings (
  entity_id           TEXT PRIMARY KEY,
  entity_type         TEXT NOT NULL,
  embedding           BLOB NOT NULL,
  model_version       TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projection_field_provenance (
  entity_id           TEXT NOT NULL,
  field               TEXT NOT NULL,
  event_id            TEXT NOT NULL,
  proposal_id         TEXT,
  capture_id          TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model_version       TEXT NOT NULL,
  confidence          REAL,
  is_human_confirmed  INTEGER NOT NULL,
  recorded_at         TEXT NOT NULL,
  PRIMARY KEY (entity_id, field)
) STRICT;

CREATE TABLE IF NOT EXISTS projection_redirects (
  from_id             TEXT PRIMARY KEY,
  to_id               TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projection_position (
  projection_name     TEXT PRIMARY KEY,
  position            INTEGER NOT NULL,
  is_rebuilding       INTEGER NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS projection_capture_search USING fts5 (
  capture_id UNINDEXED,
  text,
  tokenize = 'unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS projection_entity_search USING fts5 (
  entity_id UNINDEXED,
  entity_type UNINDEXED,
  text,
  tokenize = 'unicode61'
);

CREATE INDEX IF NOT EXISTS events_by_aggregate ON events (aggregate_id, aggregate_version);
CREATE INDEX IF NOT EXISTS events_by_capture ON events (capture_id);
CREATE INDEX IF NOT EXISTS proposals_by_capture ON extraction_proposals (capture_id, ordinal);
CREATE INDEX IF NOT EXISTS dispositions_by_capture ON proposal_dispositions (capture_id);
CREATE INDEX IF NOT EXISTS discards_by_expiry ON proposal_dispositions (disposition, expires_at);
CREATE INDEX IF NOT EXISTS entities_by_type ON projection_entities (entity_type, name);
CREATE INDEX IF NOT EXISTS aliases_by_alias ON projection_aliases (alias);
CREATE INDEX IF NOT EXISTS relations_by_from ON projection_relations (from_id);
CREATE INDEX IF NOT EXISTS relations_by_to ON projection_relations (to_id);
CREATE INDEX IF NOT EXISTS embeddings_by_type ON projection_embeddings (entity_type);

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
