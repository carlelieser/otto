// Runs the SQLite spike (runtime.md §4) end to end and reports against the bars.
//
//   node src/run.js [--seed 42] [--keep] [--db path] [--json out.json]

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { applySchema, applyVectorSchema, applyPragmas } from './schema.js';
import { generateCorpus, generateEmbeddings } from './generate.js';
import { CORPUS_SPEC } from './corpus.js';
import {
  BARS, verdict, measureRebuild, measureCatchup, measureEntityView,
  measureVector, measureFts, measureAppend, measureSize, measureSnapshotResume,
} from './measure.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const SEED = Number(arg('seed', 42));
const DB_PATH = resolve(arg('db', resolve(here, '../.data/spike.db')));
const JSON_OUT = arg('json', null);
// Scales the whole corpus. The bars are defined at ×1; running above it finds
// where the design actually breaks, which is what makes a wide pass meaningful.
const SCALE = Number(arg('scale', 1));

const t = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`);
const fmt = (bar, v) => (bar.unit === 'MB' ? `${v.toFixed(1)} MB` : t(v));

function log(...a) { console.log(...a); }

function banner(title) {
  log(`\n\x1b[1m${title}\x1b[0m`);
  log('─'.repeat(72));
}

async function main() {
  banner('Otto — SQLite spike (runtime.md §4)');
  log(`Seed ${SEED} · Node ${process.version} · ${process.platform}/${process.arch}`);

  mkdirSync(dirname(DB_PATH), { recursive: true });
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (existsSync(f)) rmSync(f);
  }

  const db = new Database(DB_PATH);
  applyPragmas(db);

  let vecOk = true;
  let vecVersion = null;
  try {
    sqliteVec.load(db);
    vecVersion = db.prepare('SELECT vec_version() AS v').get().v;
    applyVectorSchema(db);
  } catch (err) {
    vecOk = false;
    log(`\n\x1b[33msqlite-vec unavailable: ${err.message}\x1b[0m`);
  }

  applySchema(db);
  log(`SQLite ${db.prepare('SELECT sqlite_version() AS v').get().v} · journal_mode=${db.pragma('journal_mode', { simple: true })}` +
      (vecOk ? ` · sqlite-vec ${vecVersion}` : ' · sqlite-vec MISSING'));

  // --- Corpus -------------------------------------------------------------
  banner('1. Generating synthetic corpus');
  const spec = SCALE === 1
    ? CORPUS_SPEC
    : Object.fromEntries(Object.entries(CORPUS_SPEC).map(([k, v]) =>
        [k, k === 'years' ? v : Math.round(v * SCALE)]));
  log(`Target: ${spec.captures} Captures, ~3,000 entities, ~10,000 relations over ${spec.years} years` +
      (SCALE !== 1 ? `  \x1b[33m(scale ×${SCALE} — bars are defined at ×1)\x1b[0m` : ''));
  const gt0 = performance.now();
  const corpus = generateCorpus(db, { seed: SEED, spec, log });
  if (vecOk) {
    generateEmbeddings(db, corpus.entities, SEED + 1);
    log(`  embeddings: ${corpus.entities.length} × 384d`);
  }
  log(`Generated in ${t(performance.now() - gt0)}`);

  const counts = {
    captures: db.prepare('SELECT COUNT(*) c FROM captures').get().c,
    events: db.prepare('SELECT COUNT(*) c FROM events').get().c,
    entities: corpus.entities.length,
    relations: corpus.relationCount,
    proposals: db.prepare('SELECT COUNT(*) c FROM d_proposals').get().c,
  };
  log(`Actual: ${counts.captures} Captures · ${counts.events} events · ${counts.entities} entities · ${counts.relations} relations · ${counts.proposals} proposals`);

  // --- Measurements -------------------------------------------------------
  const results = {};

  banner('2. Measurements');

  process.stdout.write('  rebuild … ');
  results.rebuild = measureRebuild(db);
  log(t(results.rebuild.value));

  process.stdout.write('  catch-up (100 events × 20 rounds) … ');
  results.catchup = measureCatchup(db, corpus.entities);
  log(`p95 ${t(results.catchup.value)}`);

  process.stdout.write('  entity view (×300) … ');
  results.entity_view = measureEntityView(db, corpus.entities);
  log(`p95 ${t(results.entity_view.value)}`);

  if (vecOk) {
    process.stdout.write('  vector search (×200) … ');
    results.vector = measureVector(db);
    log(`p95 ${t(results.vector.value)}`);
  } else {
    results.vector = { value: Infinity, detail: { error: 'sqlite-vec not loaded' } };
    log('  vector search … SKIPPED (sqlite-vec unavailable)');
  }

  process.stdout.write('  full-text search (×200) … ');
  results.fts = measureFts(db);
  log(`p95 ${t(results.fts.value)}`);

  process.stdout.write('  event append (×500) … ');
  results.append = measureAppend(db, corpus.entities);
  log(`p95 ${t(results.append.value)}`);

  // Fold the probe events in so the DB is in a consistent state before sizing.
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();
  results.size = measureSize(DB_PATH);
  log(`  database size … ${results.size.value.toFixed(1)} MB`);

  banner('3. Snapshot-resumed rebuild (runtime.md §4 fallback)');
  const resume = measureSnapshotResume(db);
  log(`  tail replay of ${resume.detail.tail_events} events (10% of log): ${t(resume.value)}`);

  // --- Report -------------------------------------------------------------
  banner('4. Results against the bars');
  const pad = (s, n) => String(s).padEnd(n);
  log(pad('Measurement', 46) + pad('Result', 13) + pad('Pass', 12) + 'Verdict');
  log('─'.repeat(85));

  const summary = [];
  let worst = 'PASS';
  for (const bar of BARS) {
    const v = results[bar.key].value;
    const vd = Number.isFinite(v) ? verdict(bar.key, v) : 'FAIL';
    if (vd === 'FAIL') worst = 'FAIL';
    else if (vd === 'WARN' && worst !== 'FAIL') worst = 'WARN';
    const colour = vd === 'PASS' ? '\x1b[32m' : vd === 'WARN' ? '\x1b[33m' : '\x1b[31m';
    const passStr = bar.unit === 'MB' ? `≤ ${(bar.pass / 1024).toFixed(0)} GB` : `≤ ${t(bar.pass)}`;
    log(
      pad(bar.label, 46) +
      pad(Number.isFinite(v) ? fmt(bar, v) : 'n/a', 13) +
      pad(passStr, 12) +
      `${colour}${vd}\x1b[0m`
    );
    summary.push({ key: bar.key, label: bar.label, value: v, unit: bar.unit, pass: bar.pass, fail: bar.fail, verdict: vd, detail: results[bar.key].detail });
  }

  log('─'.repeat(85));
  const overallColour = worst === 'PASS' ? '\x1b[32m' : worst === 'WARN' ? '\x1b[33m' : '\x1b[31m';
  log(`Overall: ${overallColour}${worst}\x1b[0m` + (worst === 'WARN' ? '  (design holds, needs attention — recorded, not green)' : ''));

  const payload = {
    ran_at: new Date().toISOString(),
    seed: SEED,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    sqlite: db.prepare('SELECT sqlite_version() AS v').get().v,
    sqlite_vec: vecVersion,
    corpus: counts,
    results: summary,
    snapshot_resume: { value: resume.value, ...resume.detail },
    overall: worst,
  };

  if (JSON_OUT) {
    writeFileSync(resolve(JSON_OUT), JSON.stringify(payload, null, 2));
    log(`\nJSON written to ${resolve(JSON_OUT)}`);
  }

  db.close();
  if (!flag('keep')) {
    for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
      if (existsSync(f)) rmSync(f);
    }
  } else {
    log(`\nDatabase kept at ${DB_PATH}`);
  }

  process.exitCode = worst === 'FAIL' ? 1 : 0;
}

main().catch((err) => {
  console.error('\n\x1b[31mSpike failed to run:\x1b[0m', err);
  process.exit(2);
});
