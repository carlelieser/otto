/**
 * Every table a rebuild empties, named in one place.
 *
 * `add.md` §10 asks that "is this rebuildable?" be answerable by looking at the
 * name, and the `projection_` prefix answers it. This list is the operational
 * half of that promise: a `projection_` table missing from here survives a
 * rebuild and quietly becomes a second truth, which is the one failure the
 * naming convention alone cannot prevent.
 *
 * `projection_position` is deliberately absent. It is the bookkeeping *about*
 * the rebuild rather than a projection of the log, and clearing it inside the
 * transaction that clears everything else would erase the rebuild flag the
 * crash-recovery path depends on.
 */
export const PROJECTION_TABLES = [
  "projection_entities",
  "projection_aliases",
  "projection_relations",
  "projection_field_provenance",
  "projection_embeddings",
  "projection_redirects",
] as const;

/**
 * The FTS5 tables, listed apart because they are emptied the same way and
 * created differently.
 *
 * Kept separate so the distinction stays visible: these are virtual tables with
 * no `STRICT` clause and no ordinary indexes, and a future operation that has
 * to treat them specially — an `optimize`, a rebuild of the index itself —
 * has a list to reach for rather than a filter over names.
 */
export const SEARCH_TABLES = ["projection_capture_search", "projection_entity_search"] as const;
