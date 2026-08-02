import type Database from "better-sqlite3";
import type { Entity } from "../../domain/knowledge/entity.js";
import type { FieldProvenance } from "../../domain/knowledge/projected-state.js";
import type { Relation } from "../../domain/knowledge/relation.js";
import { toEntityParameters, toRelationParameters } from "./entity-row.js";
import { toProvenanceParameters } from "./provenance-row.js";

const UPSERT_ENTITY = `
INSERT INTO projection_entities (entity_id, entity_type, fields, name, version)
VALUES (@entity_id, @entity_type, @fields, @name, @version)
ON CONFLICT (entity_id) DO UPDATE SET
  entity_type = excluded.entity_type,
  fields = excluded.fields,
  name = excluded.name,
  version = excluded.version`;

const DELETE_ALIASES = `DELETE FROM projection_aliases WHERE entity_id = ?`;

const INSERT_ALIAS = `
INSERT INTO projection_aliases (entity_id, alias) VALUES (?, ?)
ON CONFLICT (entity_id, alias) DO NOTHING`;

const INSERT_RELATION = `
INSERT INTO projection_relations (relation_name, from_id, from_type, to_id, to_type)
VALUES (@relation_name, @from_id, @from_type, @to_id, @to_type)
ON CONFLICT (relation_name, from_id, to_id) DO NOTHING`;

const DELETE_PROVENANCE = `DELETE FROM projection_field_provenance WHERE entity_id = ?`;

const INSERT_PROVENANCE = `
INSERT INTO projection_field_provenance (
  entity_id, field, event_id, proposal_id, capture_id,
  provider, model_version, confidence, is_human_confirmed, recorded_at
) VALUES (
  @entity_id, @field, @event_id, @proposal_id, @capture_id,
  @provider, @model_version, @confidence, @is_human_confirmed, @recorded_at
)`;

const DELETE_ENTITY_SEARCH = `DELETE FROM projection_entity_search WHERE entity_id = ?`;

const DELETE_ENTITY = `DELETE FROM projection_entities WHERE entity_id = ?`;

const UPSERT_REDIRECT = `
INSERT INTO projection_redirects (from_id, to_id) VALUES (@from_id, @to_id)
ON CONFLICT (from_id) DO UPDATE SET to_id = excluded.to_id`;

const INSERT_ENTITY_SEARCH = `
INSERT INTO projection_entity_search (entity_id, entity_type, text) VALUES (?, ?, ?)`;

/**
 * One projected entity written to its four tables: the row, its aliases, its
 * search text, and its provenance.
 *
 * Functions rather than methods for the reason `read-projection-rows.ts` gives:
 * none of this needs the store's clock or opens its own transaction. The caller
 * wraps a whole batch in one, which is what keeps the recorded position from
 * running ahead of the rows.
 */
export function writeEntityRows(
  database: Database.Database,
  entity: Entity,
  pointers: ReadonlyMap<string, FieldProvenance>,
): void {
  database.prepare(UPSERT_ENTITY).run(toEntityParameters(entity));
  writeAliases(database, entity);
  indexEntity(database, entity);
  writeProvenance(database, entity.id, pointers);
}

/**
 * Aliases are replaced rather than merged.
 *
 * What an entity's aliases are is whatever the log says they are, and a
 * projection that unioned across rebuilds would accumulate aliases the log no
 * longer supports. The "never shrinks" rule in `schema.md` §2 is a rule about
 * the differ, which is what refuses to emit a Command dropping one.
 */
function writeAliases(database: Database.Database, entity: Entity): void {
  database.prepare(DELETE_ALIASES).run(entity.id);
  const insert = database.prepare(INSERT_ALIAS);
  for (const alias of entity.fields["aliases"] ?? []) {
    if (typeof alias === "string") insert.run(entity.id, alias);
  }
}

/**
 * The searchable text of an entity: every text value it holds.
 *
 * Rebuilt wholesale per write rather than diffed, because FTS5 has no upsert
 * and a stale row would return a hit for a value the entity no longer has — a
 * search index that outlives the fact it indexed.
 */
function indexEntity(database: Database.Database, entity: Entity): void {
  database.prepare(DELETE_ENTITY_SEARCH).run(entity.id);
  const text = searchableText(entity);
  if (text !== "") {
    database.prepare(INSERT_ENTITY_SEARCH).run(entity.id, entity.type, text);
  }
}

function writeProvenance(
  database: Database.Database,
  entityId: string,
  pointers: ReadonlyMap<string, FieldProvenance>,
): void {
  database.prepare(DELETE_PROVENANCE).run(entityId);
  const insert = database.prepare(INSERT_PROVENANCE);
  for (const [field, pointer] of pointers) {
    insert.run(toProvenanceParameters(entityId, field, pointer));
  }
}

export function writeRelationRow(database: Database.Database, relation: Relation): void {
  database.prepare(INSERT_RELATION).run(toRelationParameters(relation));
}

/**
 * A merged-away identity: its rows removed, and the redirect that replaces them
 * written (ADR-0009).
 *
 * The delete and the insert belong together because they are one change to what
 * the projection says about that id — "it is not an entity, it is a reference to
 * one" — and a caller that did only the first would leave every pre-merge
 * reference resolving to nothing.
 *
 * Its aliases, search text, and provenance go too. An alias left behind would
 * keep returning the merged-away entity as a candidate for resolution, which is
 * the duplicate the merge just resolved coming back through the door candidate
 * generation reads.
 */
export function writeRedirectRow(
  database: Database.Database,
  mergedId: string,
  survivorId: string,
): void {
  database.prepare(DELETE_ENTITY).run(mergedId);
  database.prepare(DELETE_ALIASES).run(mergedId);
  database.prepare(DELETE_PROVENANCE).run(mergedId);
  database.prepare(DELETE_ENTITY_SEARCH).run(mergedId);
  database.prepare(UPSERT_REDIRECT).run({ from_id: mergedId, to_id: survivorId });
}

const CLEAR_CAPTURE_INDEX = `DELETE FROM projection_capture_search`;

/**
 * Captures indexed from the table that is truth rather than from the log.
 *
 * A Capture's text is in no event, so this projection is built from `captures`
 * directly — a projection of truth rather than of the log, which the
 * `projection_` prefix still describes accurately: derived, droppable, and
 * rebuildable from a table that cannot lose rows.
 *
 * Wholesale rather than incremental, because FTS5 has no upsert and 10,000
 * Captures is a few milliseconds. `COALESCE` prefers the corrected transcript
 * over the raw one, so Slice 9's corrections become searchable by being
 * written rather than by anything here changing.
 */
const SELECT_CAPTURE_TEXT = `
SELECT capture_id, COALESCE(corrected_text, raw_text) AS text FROM captures`;

const INSERT_CAPTURE_INDEX = `
INSERT INTO projection_capture_search (capture_id, text) VALUES (?, ?)`;

export function indexCaptureRows(database: Database.Database): void {
  database.prepare(CLEAR_CAPTURE_INDEX).run();
  const insert = database.prepare(INSERT_CAPTURE_INDEX);
  for (const row of database.prepare(SELECT_CAPTURE_TEXT).all() as CaptureTextRow[]) {
    insert.run(row.capture_id, row.text);
  }
}

interface CaptureTextRow {
  readonly capture_id: string;
  readonly text: string;
}

/**
 * Every text value on an entity, joined for the full-text index.
 *
 * Text only: a date's timestamp is not something anyone searches for, and
 * indexing it would return hits on digit strings that match nothing a user
 * typed.
 */
function searchableText(entity: Entity): string {
  return Object.values(entity.fields)
    .flat()
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}
