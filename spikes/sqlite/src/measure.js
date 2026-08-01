// The seven measurements from runtime.md §4, with their stated bars.
//
// Reporting rule from qa.md §8: between pass and fail is a band where the design
// holds but needs attention. A result in that band is a WARN that gets recorded,
// not a green build.

import { performance } from 'node:perf_hooks';
import { statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { makeEmbedding, mulberry32, id } from './corpus.js';
import { project, dropProjections, currentPosition, buildStatements } from './project.js';
import { ENTITY_TYPES } from './schema.js';

export const BARS = [
  { key: 'rebuild',      label: 'Full projection rebuild from event zero', pass: 60_000, fail: 300_000, unit: 'ms' },
  { key: 'catchup',      label: 'Incremental catch-up, 100 events',        pass: 500,    fail: 2_000,   unit: 'ms' },
  { key: 'entity_view',  label: 'Entity view — row + relations + provenance', pass: 50,  fail: 200,     unit: 'ms' },
  { key: 'vector',       label: 'Vector search over 3,000 entities, top-20', pass: 100,  fail: 500,     unit: 'ms' },
  { key: 'fts',          label: 'Full-text search over 10,000 Captures',   pass: 100,    fail: 500,     unit: 'ms' },
  { key: 'append',       label: 'Event append with WAL, sidecar writing',  pass: 10,     fail: 50,      unit: 'ms' },
  { key: 'size',         label: 'Database size on disk',                   pass: 2 * 1024, fail: 10 * 1024, unit: 'MB' },
];

export function verdict(key, value) {
  const bar = BARS.find((b) => b.key === key);
  if (value <= bar.pass) return 'PASS';
  if (value > bar.fail) return 'FAIL';
  return 'WARN';
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    min: s[0],
    median: at(0.5),
    p95: at(0.95),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

// --- 1. Full rebuild ---------------------------------------------------------
// Drops every projection and folds the whole log from event zero.
export function measureRebuild(db) {
  dropProjections(db);
  const t0 = performance.now();
  const { applied } = project(db, { fromSeq: 0 });
  const elapsed = performance.now() - t0;
  return { value: elapsed, detail: { events: applied } };
}

// --- 2. Incremental catch-up, 100 events -------------------------------------
// Appends 100 fresh events and times the projector folding exactly those.
// Repeated so the number is a distribution, not a single sample.
export function measureCatchup(db, entities, rounds = 20) {
  const rng = mulberry32(1234);
  const insert = db.prepare(`
    INSERT INTO events (id, type, version, aggregate_id, aggregate_type, payload,
                        proposal_id, capture_id, provider, model_version,
                        confidence, human_confirmed, occurred_at)
    VALUES (@id, 'FieldSet', 1, @aggregate_id, @aggregate_type, @payload,
            @proposal_id, NULL, 'local', 'qwen3-8b-instruct', 0.8, 0, @occurred_at)
  `);
  const stmts = buildStatements(db);
  const samples = [];

  for (let r = 0; r < rounds; r++) {
    // Append 100 events (not timed — this is the pipeline's write, measured
    // separately in measureAppend).
    const batch = db.transaction(() => {
      for (let i = 0; i < 100; i++) {
        const e = entities[Math.floor(rng() * entities.length) % entities.length];
        insert.run({
          id: id('ev', 'catchup', String(r), String(i), e.id),
          aggregate_id: e.id,
          aggregate_type: e.type,
          payload: JSON.stringify({ field: 'summary', value: `catch-up round ${r} item ${i}` }),
          proposal_id: id('prop', 'catchup', String(r), String(i)),
          occurred_at: Date.now() + r * 1000 + i,
        });
      }
    });
    batch();

    const from = currentPosition(db);
    const t0 = performance.now();
    const { applied } = project(db, { fromSeq: from, stmts });
    const elapsed = performance.now() - t0;
    if (applied !== 100) throw new Error(`expected 100 events, applied ${applied}`);
    samples.push(elapsed);
  }

  const st = stats(samples);
  return { value: st.p95, detail: st };
}

// --- 3. Entity view ----------------------------------------------------------
// The Person view per PRD §5.3 / add.md §7: the row, its relations in both
// directions, and the provenance behind a field — which means joining through
// the event that last set it to the Proposal, Capture, model, and confidence.
export function measureEntityView(db, entities, rounds = 300) {
  const people = entities.filter((e) => e.type === 'person');
  const rng = mulberry32(99);

  const rowStmt = db.prepare('SELECT * FROM d_person WHERE id = ?');
  const outStmt = db.prepare(`
    SELECT r.name, r.to_id, r.to_type FROM d_relations r WHERE r.from_id = ?
  `);
  const inStmt = db.prepare(`
    SELECT r.name, r.from_id, r.from_type FROM d_relations r WHERE r.to_id = ?
  `);
  // Provenance for every field pointer on the row, resolved in one query.
  const provStmt = db.prepare(`
    SELECT e.id, e.type, e.capture_id, e.proposal_id, e.provider, e.model_version,
           e.confidence, e.human_confirmed, c.source, c.source_ts
      FROM events e
      LEFT JOIN captures c ON c.id = e.capture_id
     WHERE e.id IN (SELECT value FROM json_each(?))
  `);
  const redirectStmt = db.prepare('SELECT to_id FROM d_redirects WHERE from_id = ?');

  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const p = people[Math.floor(rng() * people.length) % people.length];
    const t0 = performance.now();

    // Resolve redirects transitively (ADR-0009) before reading the row.
    let target = p.id;
    for (let hop = 0; hop < 8; hop++) {
      const r = redirectStmt.get(target);
      if (!r) break;
      target = r.to_id;
    }

    const row = rowStmt.get(target);
    const out = outStmt.all(target);
    const inc = inStmt.all(target);
    let prov = [];
    if (row) {
      const eventIds = Object.keys(row)
        .filter((k) => k.endsWith('_ev') && row[k])
        .map((k) => row[k]);
      if (eventIds.length) prov = provStmt.all(JSON.stringify(eventIds));
    }

    samples.push(performance.now() - t0);
    if (i === 0 && !row) throw new Error('entity view returned no row');
    void out; void inc; void prov;
  }

  const st = stats(samples);
  return { value: st.p95, detail: st };
}

// --- 4. Vector search --------------------------------------------------------
export function measureVector(db, rounds = 200) {
  const rng = mulberry32(555);
  const stmt = db.prepare(`
    SELECT entity_id, entity_type, distance
      FROM d_entity_vec
     WHERE embedding MATCH ?
       AND k = 20
     ORDER BY distance
  `);
  const samples = [];
  let lastCount = 0;
  for (let i = 0; i < rounds; i++) {
    const q = Buffer.from(makeEmbedding(rng, i % 5).buffer);
    const t0 = performance.now();
    const rows = stmt.all(q);
    samples.push(performance.now() - t0);
    lastCount = rows.length;
  }
  if (lastCount !== 20) throw new Error(`expected top-20, got ${lastCount}`);
  const st = stats(samples);
  return { value: st.p95, detail: { ...st, returned: lastCount } };
}

// --- 5. Full-text search -----------------------------------------------------
export function measureFts(db, rounds = 200) {
  const terms = [
    'timeline', 'budget', 'compliance', 'vendor contract', 'design review',
    'deadline', 'handover', 'pricing', 'documentation', 'scale',
    'rescoping', 'retention policy', 'staffing', 'integration', 'feedback',
  ];
  const stmt = db.prepare(`
    SELECT f.capture_id, snippet(d_captures_fts, 1, '[', ']', '…', 12) AS snip, bm25(d_captures_fts) AS rank
      FROM d_captures_fts f
     WHERE d_captures_fts MATCH ?
     ORDER BY rank
     LIMIT 20
  `);
  const samples = [];
  let hits = 0;
  for (let i = 0; i < rounds; i++) {
    const term = terms[i % terms.length];
    const t0 = performance.now();
    const rows = stmt.all(term);
    samples.push(performance.now() - t0);
    hits += rows.length;
  }
  if (hits === 0) throw new Error('FTS returned no results across all queries');
  const st = stats(samples);
  return { value: st.p95, detail: { ...st, avg_hits: hits / rounds } };
}

// --- 6. Event append with WAL ------------------------------------------------
// "Sidecar writing" — a single event appended and durable, one at a time, the
// way the executor does it. No batching transaction, because that is not what
// the write path does.
export function measureAppend(db, entities, rounds = 500) {
  const insert = db.prepare(`
    INSERT INTO events (id, type, version, aggregate_id, aggregate_type, payload,
                        proposal_id, capture_id, provider, model_version,
                        confidence, human_confirmed, occurred_at)
    VALUES (@id, 'FieldSet', 1, @aggregate_id, @aggregate_type, @payload,
            @proposal_id, NULL, 'local', 'qwen3-8b-instruct', 0.9, 0, @occurred_at)
  `);
  const rng = mulberry32(777);
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const e = entities[Math.floor(rng() * entities.length) % entities.length];
    const t0 = performance.now();
    insert.run({
      id: id('ev', 'append', String(i), e.id),
      aggregate_id: e.id,
      aggregate_type: e.type,
      payload: JSON.stringify({ field: 'summary', value: `append probe ${i}` }),
      proposal_id: id('prop', 'append', String(i)),
      occurred_at: Date.now() + i,
    });
    samples.push(performance.now() - t0);
  }
  const st = stats(samples);
  return { value: st.p95, detail: st };
}

// --- 7. Database size --------------------------------------------------------
export function measureSize(dbPath) {
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const parts = {};
  let total = 0;
  for (const f of files) {
    if (existsSync(f)) {
      const b = statSync(f).size;
      parts[f.split('/').pop()] = +(b / 1024 / 1024).toFixed(2);
      total += b;
    }
  }
  return { value: total / 1024 / 1024, detail: parts };
}

// --- Snapshot-resumed rebuild ------------------------------------------------
// Not one of the seven bars. runtime.md §4 says a full-rebuild failure is only
// fatal if snapshot-resumed rebuilds also fail, so this measures the fallback
// whether or not the full rebuild passed.
export function measureSnapshotResume(db, snapshotFraction = 0.9) {
  const total = db.prepare('SELECT MAX(seq) AS m FROM events').get().m;
  const snapshotAt = Math.floor(total * snapshotFraction);

  dropProjections(db);
  project(db, { fromSeq: 0 });
  // At this point the projection reflects the whole log; a snapshot taken at
  // `snapshotAt` would let a rebuild resume from there. Simulate by replaying
  // only the tail, which is what a resumed rebuild does.
  const t0 = performance.now();
  const { applied } = project(db, { fromSeq: snapshotAt });
  const elapsed = performance.now() - t0;
  return { value: elapsed, detail: { tail_events: applied, resumed_from: snapshotAt, total } };
}

export { stats };
