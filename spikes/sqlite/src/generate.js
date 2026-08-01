// Writes the synthetic corpus into the truth tables: captures + the event log.
// Projections are NOT written here — they are built by the projector, which is
// the thing the rebuild measurement times.

import { createHash } from 'node:crypto';
import {
  CORPUS_SPEC, generateEntities, captureText, fieldValue, makeEmbedding,
  mulberry32, pick, pickInt, id, SOURCES, YEAR_MS,
} from './corpus.js';
import { SHARED_FIELDS, TYPE_FIELDS, RELATION_NAMES } from './schema.js';

const PROVIDERS = [
  { provider: 'anthropic', model_version: 'claude-sonnet-5' },
  { provider: 'local', model_version: 'qwen3-8b-instruct' },
];

// Which relation names are legal for a given (from, to) type pair, per
// schema.md §6. Generating illegal edges would make the graph unrealistic in
// exactly the dimension the entity-view query walks.
const RELATION_RULES = [
  { name: 'involves', from: 'project', to: ['person'] },
  { name: 'concerns', from: 'task', to: ['person', 'project', 'idea', 'event'] },
  { name: 'attended', from: 'event', to: ['person'] },
  { name: 'relates_to', from: 'project', to: ['project'] },
  { name: 'relates_to', from: 'idea', to: ['idea', 'project'] },
  { name: 'became', from: 'idea', to: ['project', 'task'] },
  { name: 'blocks', from: 'task', to: ['task', 'project'] },
  { name: 'blocks', from: 'project', to: ['project'] },
  { name: 'knows', from: 'person', to: ['person'] },
];

export function generateCorpus(db, { seed = 42, spec = CORPUS_SPEC, log = () => {} } = {}) {
  const rng = mulberry32(seed);
  const endTs = Date.now();
  const startTs = endTs - spec.years * YEAR_MS;

  const entities = generateEntities(rng, spec, endTs);
  const byType = {};
  for (const e of entities) (byType[e.type] ||= []).push(e);

  log(`  entities: ${entities.length}`);

  const insertCapture = db.prepare(`
    INSERT INTO captures (id, source, source_ts, content_hash, raw_text, corrected_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEvent = db.prepare(`
    INSERT INTO events (id, type, version, aggregate_id, aggregate_type, payload,
                        proposal_id, capture_id, provider, model_version,
                        confidence, human_confirmed, occurred_at)
    VALUES (@id, @type, @version, @aggregate_id, @aggregate_type, @payload,
            @proposal_id, @capture_id, @provider, @model_version,
            @confidence, @human_confirmed, @occurred_at)
  `);

  const insertProposal = db.prepare(`
    INSERT INTO d_proposals (id, capture_id, stage, target_id, target_type, field, value,
                             disposition, conf_extract, conf_resolve, provider, model_version, created_at)
    VALUES (@id, @capture_id, @stage, @target_id, @target_type, @field, @value,
            @disposition, @conf_extract, @conf_resolve, @provider, @model_version, @created_at)
  `);

  let eventCount = 0;
  let relationCount = 0;
  let proposalCount = 0;

  // Events are appended in chronological order, which is what the log actually
  // looks like and what makes the rebuild's ordering meaningful.
  const pending = [];

  function emit(ev) {
    pending.push(ev);
    eventCount++;
  }

  // 1. Entity creation + initial field sets.
  for (const e of entities) {
    const pv = pick(rng, PROVIDERS);
    const captureIdForCreate = null; // filled in during capture pass for realism
    emit({
      id: id('ev', 'created', e.id),
      type: 'EntityCreated',
      version: 1,
      aggregate_id: e.id,
      aggregate_type: e.type,
      payload: JSON.stringify({ name: e.name, type: e.type }),
      proposal_id: id('prop', e.id, 'create'),
      capture_id: captureIdForCreate,
      provider: pv.provider,
      model_version: pv.model_version,
      confidence: 0.7 + rng() * 0.3,
      human_confirmed: rng() < 0.2 ? 1 : 0,
      occurred_at: e.createdAt,
    });

    const fields = [...SHARED_FIELDS.filter((f) => f !== 'name'), ...TYPE_FIELDS[e.type]];
    // Most entities get most of their fields set at least once. `summary` is
    // always set — schema.md calls it the most frequently superseded field in
    // the model, so it should be present on every entity and then churn.
    for (const f of fields) {
      if (f !== 'summary' && rng() < 0.35) continue;
      const pv2 = pick(rng, PROVIDERS);
      emit({
        id: id('ev', 'set', e.id, f, '0'),
        type: 'FieldSet',
        version: 1,
        aggregate_id: e.id,
        aggregate_type: e.type,
        payload: JSON.stringify({ field: f, value: fieldValue(rng, e.type, f) }),
        proposal_id: id('prop', e.id, f, '0'),
        capture_id: null,
        provider: pv2.provider,
        model_version: pv2.model_version,
        confidence: 0.6 + rng() * 0.4,
        human_confirmed: rng() < 0.25 ? 1 : 0,
        occurred_at: e.createdAt + Math.floor(rng() * 1000 * 60 * 60 * 24),
      });
    }
  }

  log(`  events after creation pass: ${eventCount}`);

  // 2. Relations. ~10,000 edges drawn from the closed vocabulary.
  const relTargets = new Map();
  for (let i = 0; i < spec.relations; i++) {
    const rule = pick(rng, RELATION_RULES);
    const fromPool = byType[rule.from];
    const toType = pick(rng, rule.to);
    const toPool = byType[toType];
    if (!fromPool?.length || !toPool?.length) continue;
    const from = fromPool[Math.floor(rng() * fromPool.length) % fromPool.length];
    const to = toPool[Math.floor(rng() * toPool.length) % toPool.length];
    if (from.id === to.id) continue;

    const key = `${rule.name}:${from.id}:${to.id}`;
    if (relTargets.has(key)) continue;
    relTargets.set(key, true);

    const pv = pick(rng, PROVIDERS);
    emit({
      id: id('ev', 'rel', key),
      type: 'RelationAdded',
      version: 1,
      aggregate_id: from.id,
      aggregate_type: from.type,
      payload: JSON.stringify({
        relation_id: id('rel', key),
        name: rule.name,
        from_id: from.id, from_type: from.type,
        to_id: to.id, to_type: toType,
      }),
      proposal_id: id('prop', key),
      capture_id: null,
      provider: pv.provider,
      model_version: pv.model_version,
      confidence: 0.55 + rng() * 0.45,
      human_confirmed: rng() < 0.15 ? 1 : 0,
      occurred_at: Math.max(from.createdAt, to.createdAt) + Math.floor(rng() * 1000 * 60 * 60 * 24 * 30),
    });
    relationCount++;
  }

  log(`  relations: ${relationCount}`);

  // 3. Captures, each producing proposals and supersession events. This is the
  // bulk of the log: `summary` is the most frequently superseded field in the
  // model, so entities accumulate many events over five years.
  const captureRows = [];
  const ftsRows = [];
  const proposalRows = [];

  for (let i = 0; i < spec.captures; i++) {
    const ts = Math.floor(startTs + (i / spec.captures) * (endTs - startTs) + rng() * 1000 * 60 * 60);
    const source = pick(rng, SOURCES);

    // Each capture mentions a few entities; skewed so recent/popular entities
    // recur, which is what makes supersession realistic.
    const mentionCount = pickInt(rng, 1, 4);
    const mentioned = [];
    for (let m = 0; m < mentionCount; m++) {
      const pool = rng() < 0.5 ? byType.person : pick(rng, [byType.project, byType.task, byType.idea, byType.event]);
      // Zipf-ish: bias toward the front of the pool so some entities are hot.
      const idx = Math.floor(Math.pow(rng(), 2) * pool.length) % pool.length;
      mentioned.push(pool[idx]);
    }

    const text = captureText(rng, mentioned.map((e) => e.name));
    const contentHash = createHash('sha256').update(text).digest('hex').slice(0, 32);
    const capId = id('cap', source, String(ts), contentHash);

    // A mis-transcribed name the user later fixed (runtime.md §5). The
    // substitution must always change the text — a "correction" identical to
    // the original would not exercise the two-column storage at all.
    const corrected = source === 'voice' && rng() < 0.08
      ? text.replace(/\b([A-Z][a-z]{2,})\b/, (m) => `${m.slice(0, -1)}${m.slice(-1) === 'a' ? 'ah' : 'a'}`)
      : null;

    captureRows.push([capId, source, ts, contentHash, text, corrected, ts]);
    ftsRows.push([capId, corrected ?? text]);

    if (corrected) {
      emit({
        id: id('ev', 'corrected', capId),
        type: 'CaptureTranscriptCorrected',
        version: 1,
        aggregate_id: capId,
        aggregate_type: 'capture',
        payload: JSON.stringify({ corrected_text: corrected }),
        proposal_id: null,
        capture_id: capId,
        provider: null,
        model_version: null,
        confidence: null,
        human_confirmed: 1,
        occurred_at: ts + 60_000,
      });
    }

    // Proposals + the events for the ones that were applied.
    for (let mIdx = 0; mIdx < mentioned.length; mIdx++) {
      const e = mentioned[mIdx];
      const pv = pick(rng, PROVIDERS);
      const fields = [...SHARED_FIELDS.filter((f) => f !== 'name'), ...TYPE_FIELDS[e.type]];
      const field = pick(rng, fields);
      const value = fieldValue(rng, e.type, field);

      const confExtract = 0.5 + rng() * 0.5;
      const confResolve = 0.5 + rng() * 0.5;
      const combined = confExtract * confResolve;
      const disposition = combined > 0.72 ? 'applied' : combined > 0.4 ? 'review' : 'discarded';

      const propId = id('prop', capId, 'extract', pv.provider, pv.model_version, String(mIdx));
      proposalRows.push({
        id: propId,
        capture_id: capId,
        stage: 'extract',
        target_id: e.id,
        target_type: e.type,
        field,
        value,
        disposition,
        conf_extract: confExtract,
        conf_resolve: confResolve,
        provider: pv.provider,
        model_version: pv.model_version,
        created_at: ts,
      });
      proposalCount++;

      if (disposition === 'applied') {
        emit({
          id: id('ev', 'set', capId, e.id, field, String(mIdx)),
          type: 'FieldSet',
          version: 1,
          aggregate_id: e.id,
          aggregate_type: e.type,
          payload: JSON.stringify({ field, value }),
          proposal_id: propId,
          capture_id: capId,
          provider: pv.provider,
          model_version: pv.model_version,
          confidence: combined,
          human_confirmed: 0,
          occurred_at: ts + 1000 * mIdx,
        });
      } else if (disposition === 'review' && rng() < 0.45) {
        // The user adjudicated it later — a human-confirmed event, plus
        // sometimes a correction choosing a different value.
        const adjudicatedAt = ts + Math.floor(rng() * 1000 * 60 * 60 * 72);
        const corrValue = rng() < 0.3 ? fieldValue(rng, e.type, field) : value;
        emit({
          id: id('ev', 'set', capId, e.id, field, String(mIdx), 'adj'),
          type: 'FieldSet',
          version: 1,
          aggregate_id: e.id,
          aggregate_type: e.type,
          payload: JSON.stringify({ field, value: corrValue }),
          proposal_id: propId,
          capture_id: capId,
          provider: pv.provider,
          model_version: pv.model_version,
          confidence: combined,
          human_confirmed: 1,
          occurred_at: adjudicatedAt,
        });
      }
    }
  }

  log(`  captures: ${captureRows.length}, proposals: ${proposalCount}`);

  // 4. Merges. Redirects must be transitive (ADR-0009), so chains are built
  // deliberately rather than as isolated pairs.
  const mergeCount = Math.floor(spec.people * 0.06);
  const people = byType.person;
  for (let i = 0; i < mergeCount; i++) {
    const a = people[Math.floor(rng() * people.length) % people.length];
    const b = people[Math.floor(rng() * people.length) % people.length];
    if (a.id === b.id) continue;
    emit({
      id: id('ev', 'merge', a.id, b.id),
      type: 'EntitiesMerged',
      version: 1,
      aggregate_id: b.id,
      aggregate_type: 'person',
      payload: JSON.stringify({ merged_id: a.id, survivor_id: b.id }),
      proposal_id: null,
      capture_id: null,
      provider: null,
      model_version: null,
      confidence: null,
      human_confirmed: 1,
      occurred_at: endTs - Math.floor(rng() * YEAR_MS),
    });
  }

  // Sort chronologically — the log is append-ordered by time.
  pending.sort((a, b) => a.occurred_at - b.occurred_at || (a.id < b.id ? -1 : 1));

  const writeAll = db.transaction(() => {
    for (const row of captureRows) insertCapture.run(...row);
    const ftsStmt = db.prepare('INSERT INTO d_captures_fts (capture_id, text) VALUES (?, ?)');
    for (const row of ftsRows) ftsStmt.run(...row);
    for (const p of proposalRows) insertProposal.run(p);
    for (const ev of pending) insertEvent.run(ev);
  });
  writeAll();

  log(`  events written: ${eventCount}`);

  return { entities, eventCount, relationCount, proposalCount, captureCount: captureRows.length, rng };
}

export function generateEmbeddings(db, entities, seed = 7) {
  const rng = mulberry32(seed);
  const stmt = db.prepare(
    'INSERT INTO d_entity_vec (entity_id, entity_type, embedding) VALUES (?, ?, ?)'
  );
  const tx = db.transaction(() => {
    for (const e of entities) {
      stmt.run(e.id, e.type, Buffer.from(makeEmbedding(rng, e.typeIndex).buffer));
    }
  });
  tx();
}
