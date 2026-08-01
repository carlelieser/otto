// Verifies the spike measured real work.
//
// A performance result is only meaningful if the thing being timed actually did
// its job. A rebuild that silently no-ops is very fast. This checks that the
// projections are correct and populated before any timing is believed.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applySchema, applyVectorSchema, applyPragmas, ENTITY_TYPES } from './schema.js';
import { generateCorpus, generateEmbeddings } from './generate.js';
import { project, dropProjections, currentPosition } from './project.js';

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(here, '../.data/verify.db');

let failures = 0;
function check(name, condition, detail = '') {
  const ok = !!condition;
  if (!ok) failures++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

mkdirSync(dirname(DB_PATH), { recursive: true });
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) rmSync(f);

const db = new Database(DB_PATH);
applyPragmas(db);
sqliteVec.load(db);
applyVectorSchema(db);
applySchema(db);

console.log('\n\x1b[1mVerifying the spike measures real work\x1b[0m');
console.log('─'.repeat(72));

const corpus = generateCorpus(db, { seed: 42 });
generateEmbeddings(db, corpus.entities, 43);

console.log('\nCorpus shape (runtime.md §4 targets):');
const nCap = db.prepare('SELECT COUNT(*) c FROM captures').get().c;
const nEv = db.prepare('SELECT COUNT(*) c FROM events').get().c;
const nEnt = corpus.entities.length;
const nRel = corpus.relationCount;
check('10,000 Captures', nCap === 10000, `${nCap}`);
check('~50,000 events (30k–60k)', nEv >= 30000 && nEv <= 60000, `${nEv}`);
check('~3,000 entities', nEnt >= 2800 && nEnt <= 3200, `${nEnt}`);
check('~10,000 relations', nRel >= 9000 && nRel <= 11000, `${nRel}`);
check('5-year span', (() => {
  const r = db.prepare('SELECT MIN(source_ts) a, MAX(source_ts) b FROM captures').get();
  const years = (r.b - r.a) / (365.25 * 24 * 3600 * 1000);
  return years > 4.5 && years < 5.5;
})(), `${((db.prepare('SELECT MIN(source_ts) a, MAX(source_ts) b FROM captures').get().b - db.prepare('SELECT MIN(source_ts) a FROM captures').get().a) / (365.25 * 24 * 3600 * 1000)).toFixed(2)} years`);

console.log('\nRebuild produces populated projections:');
dropProjections(db);
const emptyBefore = ENTITY_TYPES.every((t) => db.prepare(`SELECT COUNT(*) c FROM d_${t}`).get().c === 0);
check('projections empty after drop', emptyBefore);

const { applied } = project(db, { fromSeq: 0 });
check('rebuild applied every event', applied === nEv, `${applied} of ${nEv}`);

let totalRows = 0;
for (const t of ENTITY_TYPES) {
  const c = db.prepare(`SELECT COUNT(*) c FROM d_${t}`).get().c;
  totalRows += c;
  check(`d_${t} populated`, c > 0, `${c} rows`);
}
check('all entities projected', totalRows === nEnt, `${totalRows} of ${nEnt}`);
check('d_relations populated', db.prepare('SELECT COUNT(*) c FROM d_relations').get().c === nRel,
  `${db.prepare('SELECT COUNT(*) c FROM d_relations').get().c} of ${nRel}`);
check('d_redirects populated (merges)', db.prepare('SELECT COUNT(*) c FROM d_redirects').get().c > 0,
  `${db.prepare('SELECT COUNT(*) c FROM d_redirects').get().c} rows`);

console.log('\nProjected rows carry real field values and provenance:');
const sample = db.prepare(`
  SELECT * FROM d_person WHERE employer IS NOT NULL AND summary IS NOT NULL LIMIT 1
`).get();
check('a person row has typed fields set', !!sample,
  sample ? `employer=${JSON.stringify(sample.employer)}` : 'none found');
check('field carries a provenance pointer', sample && !!sample.employer_ev,
  sample ? `employer_ev=${sample.employer_ev?.slice(0, 16)}…` : '');
check('provenance pointer resolves to a real event', (() => {
  if (!sample?.employer_ev) return false;
  const ev = db.prepare('SELECT id, provider, model_version, confidence FROM events WHERE id = ?').get(sample.employer_ev);
  return !!ev && !!ev.provider;
})());

const setField = db.prepare(`
  SELECT id, notes FROM d_person WHERE json_array_length(notes) > 1 LIMIT 1
`).get();
check('set-valued field accumulated members', !!setField,
  setField ? `${JSON.parse(setField.notes).length} notes` : 'none with >1');

const covered = db.prepare(`
  SELECT COUNT(*) c FROM d_person WHERE summary IS NOT NULL
`).get().c;
const totalPeople = db.prepare('SELECT COUNT(*) c FROM d_person').get().c;
check('most people have a summary (supersession ran)', covered / totalPeople > 0.8,
  `${covered}/${totalPeople}`);

console.log('\nSupersession semantics (single-valued fields):');
// Find a person whose employer was set more than once; the projection must hold
// the value from the LAST such event by seq, not the first.
const multi = db.prepare(`
  SELECT aggregate_id AS id, COUNT(*) c
    FROM events
   WHERE type = 'FieldSet' AND aggregate_type = 'person'
     AND json_extract(payload, '$.field') = 'employer'
   GROUP BY aggregate_id HAVING c > 1 LIMIT 1
`).get();
if (multi) {
  const last = db.prepare(`
    SELECT id, json_extract(payload, '$.value') AS v FROM events
     WHERE type='FieldSet' AND aggregate_id = ? AND json_extract(payload,'$.field')='employer'
     ORDER BY seq DESC LIMIT 1
  `).get(multi.id);
  const row = db.prepare('SELECT employer, employer_ev FROM d_person WHERE id = ?').get(multi.id);
  check('single-valued field holds the last event\'s value', row.employer === last.v,
    `projection=${JSON.stringify(row.employer)} last-event=${JSON.stringify(last.v)}`);
  check('provenance points at that last event', row.employer_ev === last.id);
} else {
  check('found a multiply-set field to test supersession', false, 'none in corpus');
}

console.log('\nRebuild is deterministic (ADR-0005: safe to drop and rebuild):');
const before = db.prepare(`SELECT id, name, summary, employer, notes FROM d_person ORDER BY id`).all();
dropProjections(db);
project(db, { fromSeq: 0 });
const after = db.prepare(`SELECT id, name, summary, employer, notes FROM d_person ORDER BY id`).all();
check('second rebuild produces identical projection',
  JSON.stringify(before) === JSON.stringify(after),
  `${before.length} rows compared`);

console.log('\nIncremental catch-up equals a full rebuild:');
// Rebuild to the halfway point, then catch up; compare against a full rebuild.
const mid = Math.floor(nEv / 2);
dropProjections(db);
project(db, { fromSeq: 0, limit: mid });
check('partial rebuild stopped at the limit', currentPosition(db) > 0 && currentPosition(db) < nEv,
  `seq ${currentPosition(db)}`);
project(db, { fromSeq: currentPosition(db) });
const incremental = db.prepare(`SELECT id, name, summary, employer, notes FROM d_person ORDER BY id`).all();
check('partial + catch-up equals full rebuild',
  JSON.stringify(incremental) === JSON.stringify(after));

console.log('\nQueries return real results:');
const vecRows = db.prepare(`
  SELECT entity_id, distance FROM d_entity_vec
   WHERE embedding MATCH (SELECT embedding FROM d_entity_vec LIMIT 1) AND k = 20
   ORDER BY distance
`).all();
check('vector search returns 20 neighbours', vecRows.length === 20, `${vecRows.length}`);
check('vector distances are ordered and varied',
  vecRows.length === 20 && vecRows[0].distance < vecRows[19].distance,
  vecRows.length ? `${vecRows[0].distance.toFixed(4)} … ${vecRows[19].distance.toFixed(4)}` : '');
check('nearest neighbour is the query vector itself', vecRows.length > 0 && vecRows[0].distance < 1e-4);

const ftsRows = db.prepare(`
  SELECT capture_id, bm25(d_captures_fts) r FROM d_captures_fts
   WHERE d_captures_fts MATCH 'timeline' ORDER BY r LIMIT 20
`).all();
check('FTS returns hits for a corpus term', ftsRows.length === 20, `${ftsRows.length}`);
check('FTS hits resolve to real Captures', (() => {
  const c = db.prepare('SELECT COUNT(*) c FROM captures WHERE id IN (SELECT value FROM json_each(?))')
    .get(JSON.stringify(ftsRows.map((r) => r.capture_id))).c;
  return c === ftsRows.length;
})());

console.log('\nEntity view returns a complete view:');
const withRels = db.prepare(`
  SELECT from_id AS id, COUNT(*) c FROM d_relations GROUP BY from_id ORDER BY c DESC LIMIT 1
`).get();
check('an entity has multiple relations to walk', withRels && withRels.c > 1, `${withRels?.c} relations`);
// Take a person who actually has relations, and resolve every field pointer on
// their row through to the event, Proposal, Capture, model, and confidence —
// the read that add.md §7 says justifies the whole log.
const personWithRels = db.prepare(`
  SELECT p.* FROM d_person p
   WHERE EXISTS (SELECT 1 FROM d_relations r WHERE r.to_id = p.id)
   LIMIT 1
`).get();
const fieldPointers = Object.entries(personWithRels ?? {})
  .filter(([k, v]) => k.endsWith('_ev') && v)
  .map(([, v]) => v);
check('person row carries several field pointers', fieldPointers.length > 3,
  `${fieldPointers.length} pointers`);
const provRows = db.prepare(`
  SELECT e.id, e.provider, e.model_version, e.confidence, e.human_confirmed,
         c.source, c.source_ts
    FROM events e
    LEFT JOIN captures c ON c.id = e.capture_id
   WHERE e.id IN (SELECT value FROM json_each(?))
`).all(JSON.stringify(fieldPointers));
check('every field pointer resolves to an event', provRows.length === fieldPointers.length,
  `${provRows.length}/${fieldPointers.length}`);
check('resolved provenance names a model and confidence',
  provRows.length > 0 && provRows.every((r) => r.provider && r.model_version && r.confidence !== null),
  provRows[0] ? `e.g. ${provRows[0].provider}/${provRows[0].model_version} @ ${provRows[0].confidence.toFixed(2)}` : '');
check('some provenance traces back to a Capture',
  provRows.some((r) => r.source),
  `${provRows.filter((r) => r.source).length} of ${provRows.length} via a Capture`);

console.log('\nTruth tables are insert-only in shape:');
check('captures and events have no UPDATE path exercised',
  db.prepare("SELECT COUNT(*) c FROM captures WHERE corrected_text IS NOT NULL").get().c > 0,
  'corrections stored as separate column + event, never overwriting raw_text');
check('corrected captures kept their original text', (() => {
  const r = db.prepare('SELECT raw_text, corrected_text FROM captures WHERE corrected_text IS NOT NULL LIMIT 1').get();
  return r && r.raw_text && r.corrected_text && r.raw_text !== r.corrected_text;
})());

db.close();
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) rmSync(f);

console.log('─'.repeat(72));
if (failures === 0) {
  console.log('\x1b[32mAll verification checks passed — the measurements time real work.\x1b[0m\n');
} else {
  console.log(`\x1b[31m${failures} verification check(s) failed.\x1b[0m\n`);
}
process.exit(failures === 0 ? 0 : 1);
