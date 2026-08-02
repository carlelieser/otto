/**
 * Every table a rebuild empties, named in one place, and why the ones Slice 6
 * added are shaped as they are.
 *
 * `add.md` §10 asks that "is this rebuildable?" be answerable by looking at the
 * name, and the `projection_` prefix answers it. This list is the operational
 * half of that promise: a `projection_` table missing from here survives a
 * rebuild and quietly becomes a second truth, which is the one failure the
 * naming convention alone cannot prevent. The reasoning lives beside the list
 * rather than beside the DDL for that reason — the two are what must not drift.
 *
 * `projection_position` is deliberately absent from the list. It is the
 * bookkeeping *about* the rebuild rather than a projection of the log, and
 * clearing it inside the transaction that clears everything else would erase
 * the rebuild flag the crash-recovery path depends on.
 *
 * ## Provenance is a table, not a column on the entity
 *
 * `projection_field_provenance` holds one row per (entity, field), naming the
 * event that last wrote it and carrying that event's provenance columns
 * flattened, exactly as `events` holds them.
 *
 * It is a separate table rather than more JSON in `projection_entities.fields`
 * because the two are read at different times. `add.md` §7 has the entity view
 * as "a row and a handful of joins" and provenance display as a distinct read
 * behind it — the Person view renders without it, and asking where one field
 * came from is a click. Folding it into the entity JSON would make every list
 * query carry six provenance columns per field it never shows.
 *
 * The columns are duplicated from `events` rather than joined to on `event_id`,
 * which is denormalisation and is the point: §7's argument is that building the
 * pointer during projection is cheap and reconstructing it later is not. A join
 * to the log on every field would be reconstruction with extra steps, and the
 * log is the one table the read path is not supposed to touch (`add.md` §6).
 *
 * ## `projection_redirects` is declared and written in Slice 8
 *
 * Merge and split are events, and the projection is where the change shows: the
 * merged-away id survives as a redirect row that reads resolve through
 * (`add.md` §6, ADR-0009). Slice 8 owns the events and the transitive
 * resolution. The table is declared now because the slice that builds the
 * projection machinery is the honest place for it.
 *
 * ## `projection_position` is what makes a rebuild interruptible
 *
 * The worker records how far it has folded, so a restart resumes rather than
 * replaying from zero. `is_rebuilding` is the half that matters for
 * correctness: `qa.md` §7.1 requires that a crash mid-rebuild not leave a
 * partially-populated projection **presented as complete**. A read surface that
 * finds the flag set knows the rows under it are a prefix of the log rather
 * than all of it, which is a different answer from "this entity does not
 * exist".
 *
 * ## The search tables are FTS5 and cannot be `STRICT`
 *
 * `add.md` §7: search is over the projections, not the log, and full-text over
 * Captures and entity fields. Both are `fts5` virtual tables, which do not take
 * a `STRICT` clause and whose columns are all text — the `UNINDEXED` ids are
 * carried so a hit can be resolved back to its row without a second lookup.
 *
 * They are populated by the projection worker rather than by triggers on
 * `captures`. A trigger would tie the search index to the write path and make
 * it the one projection that cannot be rebuilt by replaying, which is the
 * property the `projection_` prefix is a promise about. The Capture index is
 * the one built from `captures` rather than from the log, because no event
 * carries a Capture's text — so `ProjectionStore.reindexCaptures` exists, and
 * a rebuild calls it, since `reset` empties that index too.
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
 * The two Slice 7 tables that carry the prefix and are **deliberately not in
 * the list above**, which is the one exception in the file and needs saying.
 *
 * `reset` is always followed by a replay of the log, so a table belongs in the
 * list exactly when folding events puts it back. Neither of these does.
 *
 * `projection_queue_entries` is rebuildable — by re-running the differ and
 * triage over stored Captures, which is ADR-0019's argument one stage on — but
 * *not by replaying the log*, because the log holds what changed rather than
 * what Otto considered. Clearing it on a projection rebuild would empty the
 * review queue of everything nobody had answered yet, discarding pending
 * decisions to fix an unrelated corruption.
 *
 * `projection_corrections` is worse to lose. Each row is what the user chose
 * instead, and ADR-0006's whole argument is that this is unreconstructable
 * later: the compensating event carries `humanConfirmedProvenance`, which names
 * no provider and no model version, so the log cannot say which model was
 * corrected and the bootstrap counter could not be rebuilt from it. A rebuild
 * that emptied this would silently return every model to bootstrap and destroy
 * the eval set.
 *
 * They keep the prefix because they are derived rather than truth — droppable
 * deliberately, by a tool that knows what it is doing — and the prefix is a
 * claim about ownership rather than a promise that `reset` covers them. Naming
 * them here is what keeps that distinction from reading as an oversight.
 */
export const REBUILD_EXEMPT_PROJECTIONS = [
  "projection_queue_entries",
  "projection_corrections",
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
