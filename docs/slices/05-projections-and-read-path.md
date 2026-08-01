# Slice 5 — Projections and the read path

> Depends on: Slice 4. Blocks: Slices 6, 9, 10.
> Sources: [`add.md`](../add.md) §6, §7; [`runtime.md`](../runtime.md) §4, §4.1; [`qa.md`](../qa.md) §7.1, §7.5, §8; ADR-0005, ADR-0011.

## What it closes

Everything in the log becomes readable: entities with their fields and relations, each field naming the event that last set it and through it the Capture, model, and confidence behind it. Drop every projection and rebuild, and the result is byte-identical.

This is where Otto stops being a pipeline and becomes a knowledge base.

## Why here

The write path is complete and the log has events in it, which is the prerequisite — a projection with nothing to project is untestable. And every remaining slice reads: the review queue (6), briefs (9), and the dashboard (10) all query projections rather than the log.

**Provenance is built here rather than added when the UI needs it.** `add.md` §7 is specific: building the per-field pointer during projection is cheap, and reconstructing it later by scanning the log is not. This is the read that justifies the whole log existing.

## In scope

**The projection worker**, in its own process so that a full rebuild never blocks capture or the pipeline (`add.md` §4). Rebuild is a routine operation, not a disaster-recovery step (ADR-0005).

**The derived tables** (`add.md` §10): `person`, `project`, `idea`, `event`, `task` with real typed fields, each carrying a pointer to the event that last set it; `relations`; `redirects` (the table exists here, Slice 7 writes to it); `proposals` and their dispositions; `corrections` (written in Slice 6). Search indexes, embeddings, salience, and snapshots complete the set.

**Derived tables live in their own namespace** (`add.md` §10), so "is this rebuildable?" is answerable by looking at the name rather than by reading the projection code.

**Per-field provenance pointers.** Every field on every entity names the event that last set it, and through that event the Proposal, the Capture, the provider and model version, the confidence at the time, and whether a human confirmed it.

**Rebuild, snapshots, and upcasting.** Rebuild from event zero and from a snapshot. Snapshot machinery from Slice 0 is wired in with its **cadence set to never** (`runtime.md` §4.1) — full rebuild is 215 ms at the specified corpus and 15 s at 25× it, so there is nothing to tune yet. Keep the mechanism, revisit past ~1M events. Upcasting happens at read time in the projection worker, so the log is never migrated.

**Staleness tolerance as a contract.** Projections lag the log by however long the worker takes. Every read surface tolerates this, and the dashboard handles it by treating an applied event as immediately true in the local view rather than blocking on the projection catching up (`add.md` §6).

**Full-text search** over Captures and entity fields, using SQLite FTS. Note the boundary: semantic search over notes is post-MVP (PRD §7.2), and the embeddings from Slice 3 exist for candidate generation rather than for user-facing search.

**Entity reads** in `application/surface/` — the Person view as a row and a handful of joins, which is the dividend ADR-0010 pays.

**The standing performance suite** (`qa.md` §8), built against the real projector. The spike's harness was throwaway and its projection logic was a stand-in; its seven measurements become the first baseline. **Watch movement against the baseline column, not distance from the fail column** — every bar passes by 20× or better, so the bars alone will not catch a regression until it is catastrophic.

**Correctness checks alongside the timings.** A rebuild that silently no-ops is very fast. Projections populate, single-valued fields hold the last event's value, a second rebuild is byte-identical to the first, partial-plus-catch-up equals a full rebuild, provenance resolves through to model and confidence. These caught two corpus bugs during the spike that would have made its numbers meaningless.

**Entity names as a transcription initial prompt** (`runtime.md` §2), deferred from Slice 1 — the entity projection now exists to draw names from. Test with and without, since the mitigation is only worth its complexity if it measurably improves proper-noun recall.

## Not in scope

- **Salience.** Slice 9, though it is a projection and lands in the machinery built here.
- **The review queue as a surface.** Slice 6. The `proposals` projection exists here; the UI over it does not.
- **Duplicate detection.** Slice 7, also a projection.
- **The dashboard.** Slice 10. Reads are exposed through the command surface and exercised by tests, not by a window.
- **Semantic search.** Post-MVP (PRD §7.2). The seam is a projection over embeddings that already exist.

## Build order

1. The projection worker process and its subscription to the log.
2. Entity and relation projections with per-field provenance pointers.
3. Rebuild from event zero; then rebuild from a snapshot, cadence off.
4. Upcasting at read time in the worker.
5. Full-text search over Captures and entity fields.
6. Entity read surfaces in `application/surface/`.
7. The performance suite against the real projector, with its correctness checks.
8. Transcription initial-prompt mitigation, measured.

## Verification

Tier 2 (`qa.md` §7.1, §7.5) — this is the load-bearing test of the entire projection design:

- **Property-based: for any event log, dropping every projection and rebuilding produces byte-identical projection state.** Worth more than any number of example-based projection tests.
- Rebuild from a snapshot equals rebuild from event zero.
- A corrupt or stale snapshot is recoverable by deleting it and replaying fully.
- Rebuild is interruptible and resumable; a crash mid-rebuild does not leave a partially-populated projection presented as complete.
- A projection rebuild over a log containing mixed event versions produces the same result as one over an all-current-version log (`qa.md` §4.5).

**Provenance:**

- **Property-based: for any entity in any projection state, no field lacks a provenance pointer.**
- The pointer is built during projection, not reconstructed by scanning the log.
- A user-confirmed fact is distinguishable from an auto-applied one.

**Performance** (`qa.md` §8), all seven bars against the real projector, with the spike results as baseline. **If several bars degrade together, the conclusion is that the projection model is doing too much work per event — a design finding, not a test failure, and not a reason to change database.**

**Failure handling** (`qa.md` §9): the application handles a missing projection gracefully rather than erroring at the UI.

## Done when

- Every entity type is readable with its fields, relations, and per-field provenance.
- Dropping all projections and rebuilding is byte-identical, verified as a property rather than an example.
- All seven performance bars pass against the real projector, with results recorded against the spike baseline rather than the fail column.
- Search returns Captures and entities by text.
