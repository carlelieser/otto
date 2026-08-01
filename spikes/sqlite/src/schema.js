// SQL schema for the spike. Follows add.md §12: two truth tables, everything
// else derived and living in a `d_` namespace so "is this rebuildable?" is
// answerable from the name alone.
//
// This is deliberately not the production schema. It is the smallest thing that
// exercises the seven measurements in runtime.md §4 honestly: real field columns
// (ADR-0010), per-field provenance pointers (add.md §7), relations from the
// closed vocabulary (schema.md §6), transitive redirects (ADR-0009), FTS over
// Captures, and vectors over entities.

export const ENTITY_TYPES = ['person', 'project', 'idea', 'event', 'task'];

// Per-type extractable fields, from schema.md §§2-5. Shared fields first.
export const SHARED_FIELDS = ['name', 'aliases', 'summary', 'notes'];

export const TYPE_FIELDS = {
  person: ['employer', 'role', 'location', 'relationship', 'contact', 'last_contact_at'],
  project: ['status', 'blocker', 'next_action', 'outcome', 'due', 'started_at'],
  idea: ['body', 'status'],
  event: ['occurred_at', 'ends_at', 'location', 'kind', 'outcome'],
  task: ['status', 'due', 'done_at'],
};

export const RELATION_NAMES = [
  'involves', 'concerns', 'attended', 'relates_to', 'became', 'blocks', 'knows',
];

// Truth. Insert-only; no code path in Otto updates or deletes a row here.
const TRUTH = `
CREATE TABLE IF NOT EXISTS captures (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  source_ts       INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  raw_text        TEXT NOT NULL,
  corrected_text  TEXT,
  created_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS captures_source_ts ON captures (source_ts);

CREATE TABLE IF NOT EXISTS events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  version         INTEGER NOT NULL,
  aggregate_id    TEXT NOT NULL,
  aggregate_type  TEXT NOT NULL,
  payload         TEXT NOT NULL,
  -- Provenance (add.md §12): which Proposal, Capture, model, confidence,
  -- and whether a human confirmed it.
  proposal_id     TEXT,
  capture_id      TEXT,
  provider        TEXT,
  model_version   TEXT,
  confidence      REAL,
  human_confirmed INTEGER NOT NULL DEFAULT 0,
  occurred_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS events_aggregate ON events (aggregate_id, seq);
CREATE INDEX IF NOT EXISTS events_capture ON events (capture_id);
`;

// Derived. Every table below is droppable and rebuildable from the log.
function entityTable(type) {
  const cols = [...SHARED_FIELDS, ...TYPE_FIELDS[type]]
    .map((f) => {
      // Set-valued fields are stored as JSON arrays; the differ unions them.
      const isSet = f === 'aliases' || f === 'notes' || f === 'contact';
      return `  ${f} TEXT${isSet ? " NOT NULL DEFAULT '[]'" : ''},\n  ${f}_ev TEXT`;
    })
    .join(',\n');
  return `
CREATE TABLE IF NOT EXISTS d_${type} (
  id          TEXT PRIMARY KEY,
${cols},
  salience    REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS d_${type}_salience ON d_${type} (salience DESC);
CREATE INDEX IF NOT EXISTS d_${type}_updated ON d_${type} (updated_at DESC);
`;
}

const DERIVED = `
${ENTITY_TYPES.map(entityTable).join('\n')}

CREATE TABLE IF NOT EXISTS d_relations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  from_type   TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  to_type     TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS d_relations_from ON d_relations (from_id);
CREATE INDEX IF NOT EXISTS d_relations_to ON d_relations (to_id);

CREATE TABLE IF NOT EXISTS d_redirects (
  from_id     TEXT PRIMARY KEY,
  to_id       TEXT NOT NULL,
  event_id    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS d_proposals (
  id            TEXT PRIMARY KEY,
  capture_id    TEXT NOT NULL,
  stage         TEXT NOT NULL,
  target_id     TEXT,
  target_type   TEXT,
  field         TEXT,
  value         TEXT,
  disposition   TEXT NOT NULL,
  conf_extract  REAL NOT NULL,
  conf_resolve  REAL NOT NULL,
  provider      TEXT NOT NULL,
  model_version TEXT NOT NULL,
  created_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS d_proposals_disposition ON d_proposals (disposition, created_at DESC);
CREATE INDEX IF NOT EXISTS d_proposals_capture ON d_proposals (capture_id);

-- Projection-level snapshots (ADR-0011): each records the log position it reflects.
CREATE TABLE IF NOT EXISTS d_snapshots (
  projection  TEXT NOT NULL,
  log_seq     INTEGER NOT NULL,
  state       BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (projection, log_seq)
) STRICT;

CREATE TABLE IF NOT EXISTS d_projection_pos (
  projection  TEXT PRIMARY KEY,
  log_seq     INTEGER NOT NULL
) STRICT;
`;

// Full-text over Captures. External-content FTS5 would couple the index to the
// truth table's rowids; a plain contentless-adjacent table keeps the derived
// side droppable, which is the property that matters here.
const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS d_captures_fts USING fts5(
  capture_id UNINDEXED,
  text,
  tokenize = 'porter unicode61'
);
`;

export function applySchema(db) {
  db.exec(TRUTH);
  db.exec(DERIVED);
  db.exec(FTS);
}

// sqlite-vec table for entity embeddings. Dimension matches a small local
// embedding model (all-MiniLM-L6-v2 class), which is what the sidecar would run.
export const EMBEDDING_DIM = 384;

export function applyVectorSchema(db) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS d_entity_vec USING vec0(
      entity_id TEXT PRIMARY KEY,
      entity_type TEXT,
      embedding FLOAT[${EMBEDDING_DIM}]
    );
  `);
}

export function applyPragmas(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -64000'); // 64 MB
  db.pragma('mmap_size = 268435456'); // 256 MB
  db.pragma('temp_store = MEMORY');
}
