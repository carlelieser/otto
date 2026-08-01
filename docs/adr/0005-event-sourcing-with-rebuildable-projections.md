# Event sourcing: the log is source of truth, entity tables are projections

---
Status: accepted
---

> **Amended after ADR-0010.** This ADR's original rationale leaned on ADR-0004, since reversed. The decision stands, and the standalone justification is restated in full below so that no accepted decision here rests on a reversed one. The four mechanisms this ADR left undesigned — snapshotting, event versioning, staleness, and idempotency — are settled in [ADR-0011](./0011-mechanics-of-an-immutable-log.md).

The append-only event log, together with the immutable capture records that feed it, is Otto's **sole source of truth**. Every entity table, the search index, embeddings, backlinks, and counts are **projections** — derived state, rebuildable from the log alone, and safe to drop. A correction is never an edit: it is a compensating event appended to the log, after which affected projections are rebuilt. History is never mutated.

We chose this over the lighter alternative (mutable entity tables plus an append-only `changes` table carrying provenance columns), which would have delivered the audit trail and revert without any replay machinery.

**The justification, restated without ADR-0004.** The original argument was that Assertions made the log the model rather than an audit artifact beside it. That argument is gone, and three independent ones remain, each sufficient on its own.

*The domain is revision* (ADR-0002). Otto's subject is not the current state of the user's knowledge but how that understanding changed. A system whose subject matter is change stores change as its primary artifact; storing current state and journaling the changes beside it inverts what is truth and what is derived, in the one system where that distinction is the product.

*Provenance is required per field, and is the trust mechanism* (PRD §8). Every fact must name the Capture, Proposal, model, and Confidence behind it. Under mutable tables that means provenance columns on every field of every entity, growing with the schema; under event sourcing it is one shape on one table, and the per-field pointer is a projection detail (ADD §7). The lighter option gets more expensive precisely as the schema grows, which is the wrong direction.

*Derived state is disposable, and Otto has a lot of it.* Embeddings, search indexes, salience, counts, and redirects are all rebuildable from the log. Swapping the embedding model is a rebuild, losing the vector index is survivable, salience rules can be replaced and recomputed over all history (ADR-0015), and a write never needs to update six things atomically. Under mutable tables each of these becomes a migration with no source to migrate from.

The cost — event versioning discipline, replay growth, read-side lag — is real and is accepted below. What changed with ADR-0010 is that reads got *cheaper*, not that the log got less justified: entities carrying fields means a projection row is a plain select rather than a synthesis, which removes the largest cost the original decision accepted.

## Considered Options

- **Mutable tables + append-only `changes` log** — the pragmatic option, explicitly evaluated. Cheaper day one; rejected for the reason above.

## Consequences

- We take on **event versioning** as a permanent discipline: an event type's payload shape can never change in place, only be superseded by a new version with an upcast path. The mechanism is read-time upcasting in the projection worker (ADR-0011).
- Replay cost grows with the log. Addressed by projection-level snapshotting (ADR-0011); the spike measured the cost as 215 ms over a five-year corpus, so the cadence is set to "never" for MVP with the mechanism retained (`runtime.md` §4.1).
- The read side may lag the write side. Every UI surface must tolerate an entity projection that is briefly stale relative to the events that produced it. The dashboard handles this by treating an applied event as immediately true locally rather than blocking on the projection (ADD §6).
- This assumes SQLite can carry an append-only log plus rebuildable projections at single-user scale. **The spike has validated it** — all seven bars pass, the closest by a factor of 20 (`runtime.md` §4, ADR-0013). The assumption this ADR rested on is now a measurement.
