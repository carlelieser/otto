// The projection worker. Folds the event log into the derived tables.
//
// This is the code the rebuild and catch-up measurements time, so it is written
// the way the real one would be rather than the fastest way possible: events are
// read in order, upcast at read time (ADR-0011), and each one updates the
// projection row plus its per-field provenance pointer (add.md §7).

import { ENTITY_TYPES, SHARED_FIELDS, TYPE_FIELDS } from './schema.js';

const SET_FIELDS = new Set(['aliases', 'notes', 'contact']);

const DERIVED_TABLES = [
  ...ENTITY_TYPES.map((t) => `d_${t}`),
  'd_relations',
  'd_redirects',
];

export function dropProjections(db) {
  const tx = db.transaction(() => {
    for (const t of DERIVED_TABLES) db.exec(`DELETE FROM ${t}`);
    db.exec('DELETE FROM d_projection_pos');
  });
  tx();
}

// Read-time upcast. Only v1 shapes exist in the spike, but the dispatch is here
// because it is on the hot path of every rebuild and its cost should be counted.
function upcast(type, version, payload) {
  if (version === 1) return payload;
  throw new Error(`no upcast path for ${type} v${version}`);
}

function buildStatements(db) {
  const upsert = {};
  const setField = {};

  for (const type of ENTITY_TYPES) {
    upsert[type] = db.prepare(`
      INSERT INTO d_${type} (id, name, name_ev, created_at, updated_at)
      VALUES (@id, @name, @name_ev, @ts, @ts)
      ON CONFLICT(id) DO UPDATE SET name = @name, name_ev = @name_ev, updated_at = @ts
    `);

    const fields = [...SHARED_FIELDS, ...TYPE_FIELDS[type]];
    setField[type] = {};
    for (const f of fields) {
      if (SET_FIELDS.has(f)) {
        // Set-valued: union, never silently drop a member (schema.md §1).
        setField[type][f] = db.prepare(`
          UPDATE d_${type}
             SET ${f} = (
                   SELECT json_group_array(v) FROM (
                     SELECT DISTINCT value AS v FROM (
                       SELECT value FROM json_each(${f})
                       UNION ALL SELECT @value
                     )
                   )
                 ),
                 ${f}_ev = @event_id,
                 updated_at = @ts
           WHERE id = @id
        `);
      } else {
        // Single-valued: supersede.
        setField[type][f] = db.prepare(`
          UPDATE d_${type}
             SET ${f} = @value, ${f}_ev = @event_id, updated_at = @ts
           WHERE id = @id
        `);
      }
    }
  }

  return {
    upsert,
    setField,
    insertRelation: db.prepare(`
      INSERT INTO d_relations (id, name, from_id, from_type, to_id, to_type, event_id, created_at)
      VALUES (@id, @name, @from_id, @from_type, @to_id, @to_type, @event_id, @created_at)
      ON CONFLICT(id) DO NOTHING
    `),
    insertRedirect: db.prepare(`
      INSERT INTO d_redirects (from_id, to_id, event_id) VALUES (@from_id, @to_id, @event_id)
      ON CONFLICT(from_id) DO UPDATE SET to_id = @to_id, event_id = @event_id
    `),
    setPos: db.prepare(`
      INSERT INTO d_projection_pos (projection, log_seq) VALUES ('entities', @seq)
      ON CONFLICT(projection) DO UPDATE SET log_seq = @seq
    `),
  };
}

export function currentPosition(db) {
  const row = db.prepare("SELECT log_seq FROM d_projection_pos WHERE projection = 'entities'").get();
  return row ? row.log_seq : 0;
}

// Applies every event with seq > fromSeq. Returns the number applied.
export function project(db, { fromSeq = 0, limit = null, stmts = null } = {}) {
  const s = stmts ?? buildStatements(db);

  // Events are read in ordered chunks rather than streamed through one cursor.
  // better-sqlite3 forbids writing on a connection with an open iterator, and
  // the real projector has the same shape for a better reason: a chunk is the
  // unit of work it can commit and record a position for, so a rebuild
  // interrupted mid-log resumes from the last committed chunk rather than
  // restarting. CHUNK is large enough that per-batch overhead is noise.
  const readStmt = db.prepare(`
    SELECT seq, id, type, version, aggregate_id, aggregate_type, payload, occurred_at
      FROM events
     WHERE seq > ?
     ORDER BY seq
     LIMIT ?
  `);

  let applied = 0;
  let lastSeq = fromSeq;

  const applyChunk = db.transaction((chunk) => {
    for (const ev of chunk) {
      const payload = upcast(ev.type, ev.version, JSON.parse(ev.payload));
      const type = ev.aggregate_type;

      switch (ev.type) {
        case 'EntityCreated':
          s.upsert[type].run({
            id: ev.aggregate_id,
            name: payload.name,
            name_ev: ev.id,
            ts: ev.occurred_at,
          });
          break;

        case 'FieldSet': {
          const stmt = s.setField[type]?.[payload.field];
          if (stmt) {
            stmt.run({
              id: ev.aggregate_id,
              value: String(payload.value),
              event_id: ev.id,
              ts: ev.occurred_at,
            });
          }
          break;
        }

        case 'RelationAdded':
          s.insertRelation.run({
            id: payload.relation_id,
            name: payload.name,
            from_id: payload.from_id,
            from_type: payload.from_type,
            to_id: payload.to_id,
            to_type: payload.to_type,
            event_id: ev.id,
            created_at: ev.occurred_at,
          });
          break;

        case 'EntitiesMerged':
          s.insertRedirect.run({
            from_id: payload.merged_id,
            to_id: payload.survivor_id,
            event_id: ev.id,
          });
          break;

        case 'CaptureTranscriptCorrected':
          // Captures are truth, not a projection; nothing to fold here.
          break;

        default:
          break;
      }

      lastSeq = ev.seq;
      applied++;
    }
    s.setPos.run({ seq: lastSeq });
  });

  const CHUNK = 5000;
  for (;;) {
    const remaining = limit === null ? CHUNK : Math.min(CHUNK, limit - applied);
    if (remaining <= 0) break;
    const chunk = readStmt.all(lastSeq, remaining);
    if (chunk.length === 0) break;
    applyChunk(chunk);
  }

  return { applied, lastSeq };
}

export { buildStatements };
