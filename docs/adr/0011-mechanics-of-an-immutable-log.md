# Snapshots, upcasts, staleness, and idempotency: the mechanics of an immutable log

---
Status: accepted
---

ADR-0005 accepted event sourcing and left four mechanisms undesigned, each of which it correctly identified as a consequence rather than a choice. They are settled together here because they are one decision seen from four sides: **an append-only log is never rewritten, so everything that would otherwise be a migration becomes a read-time or apply-time operation instead.**

**Snapshotting is a projection concern, not an aggregate one.** Rebuilds periodically write a snapshot of each projection together with the log position it reflects, and a rebuild resumes from the most recent snapshot rather than from event zero. Snapshots are themselves derived and disposable, so a corrupt or stale one is fixed by deleting it and replaying fully. The alternative — per-aggregate snapshots, the conventional event-sourcing answer — solves a problem Otto does not have, since nothing in Otto loads an aggregate by folding its events (ADR-0010 made reads plain queries against projections). Snapshotting the projection keeps rebuild cost proportional to recent activity with no per-aggregate machinery.

**Event versioning is a read-time upcast.** Every event carries a type and a version; payload shapes are never changed in place; a new shape is a new version with an upcast function from the old one. Upcasting happens in the projection worker as events are read, so the log is never migrated and old events are never rewritten. This is the only option consistent with an immutable log — a migration that rewrites events destroys the property the log exists to provide.

**Staleness is optimistic concurrency on the Proposal.** A Proposal is stamped with the version of the aggregate it was computed against and the version is checked at apply time. This is needed because of user think-time — a Proposal can sit in the Review queue for days while its target changes — and not because of parallelism, since the pipeline is serialised (ADD §4). On mismatch the Proposal re-enters at the differ rather than at extraction: the text did not change, only the comparison against current state did.

**Idempotency is derived ids.** A stable Capture id is computed from source, timestamp, and content hash; downstream ids derive from it, the stage, the provider and model version, and an ordinal. Retries produce identical ids and apply as no-ops. Re-extraction under a different model produces different ids and therefore new Proposals — which is the correct behaviour, since a better model should be able to say something new about an old Capture, and would be impossible if ids derived from the Capture alone.

## Considered Options

- **Per-aggregate snapshots** — rejected above: conventional, and solves a problem created by a read model Otto does not use.
- **Lazy migration of events in place** — rejected: cheaper to read, and it makes the log mutable, which forfeits the one guarantee the log is for.
- **Pessimistic locking on review targets** — rejected: locking an entity because a Proposal about it is queued would let a stale Proposal block the user's own edits.
- **Idempotency keyed on Capture id alone** — rejected: makes re-extraction under a new model a no-op, silently.

## Consequences

- **Upcast functions accumulate and can never be deleted.** This is the honest price of an immutable log, and it is paid forever.
- A re-proposal that produces no change is closed rather than re-queued; one that produces a different change goes to review regardless of Confidence, because the thing the user was looking at moved.
- Re-extraction is a manual, scoped action rather than automatic on model upgrade — automatic re-processing would flood the Review queue and re-litigate settled knowledge. The exception is a corrected transcript (ADR-0014), where the user has said the input was wrong.
- Snapshot cadence is a tuning parameter with no correct value until the SQLite spike (ADR-0013) measures rebuild cost. **The spike has now measured it: 215 ms to rebuild from event zero over a five-year corpus, 15 s at 25× that volume. The cadence is therefore "never" for MVP — the mechanism is kept because it is the expensive part to add later, and it stays off until the log approaches ~1M events (`runtime.md` §4.1).**
