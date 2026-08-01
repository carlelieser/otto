# Slice 0 — Foundation

> Depends on: nothing. Blocks: everything.
> Sources: [`add.md`](../add.md) §3, §5.6, §10; [`qa.md`](../qa.md) §4.1, §12; ADR-0001, ADR-0003, ADR-0005, ADR-0011, ADR-0013.

## What it closes

A domain event can be appended to the log by the executor and read back, in a repository whose layering boundaries fail the build when violated. Nothing about knowledge is modelled yet — this is the write surface every later slice goes through, proven with one event type.

This is the only horizontal slice, and it is horizontal on purpose. The executor-as-sole-writer boundary is what ADR-0003 calls the highest-value in the tree; building it four times as four features need it would erode it exactly the way ADR-0001 predicts.

## Why here

Three things in this slice are cheap now and expensive later:

**The lint rules.** `qa.md` §12 puts them second in the execution order, immediately after the spike, "from the first commit, per ADR-0001 and ADR-0003." A boundary rule added after the code exists is a refactor; added before, it is a constraint that was never violated.

**Provenance on the event.** ADR-0006 notes that provenance not recorded at write time is unreconstructable later. The event's shape has to carry it from the first event ever written.

**Event versioning.** `add.md` §6 accepts it as permanent discipline. The version field and the upcast seam cost nothing at event type #1 and are a log migration at event type #20 — which is the one migration an immutable log does not permit.

## In scope

**The repository skeleton**, as `add.md` §3's tree: `domain/`, `capture/`, `inference/`, `application/`, `ports/`, `infrastructure/`, `interfaces/`. Directories that later slices fill exist empty rather than being created ad hoc.

**Four lint rules, failing the build** (`qa.md` §4.1). These are tests and belong in CI:

- No module under `inference/` imports a repository port, the event store port, or anything from `application/`.
- `domain/` imports nothing else in `src/`.
- Only the composition root imports `infrastructure/`.
- A grep for `confidence` under `domain/` returns nothing.

**The event log.** `events` table, append-only, each row carrying type, version, aggregate, payload, and provenance: Proposal, Capture, provider, model version, confidence at the time of inference, and the human-confirmed flag (`add.md` §10). Insert-only in the application layer *and* enforced by SQLite triggers rejecting UPDATE and DELETE — `qa.md` §4.1 asks for both, because a test that the application declines to do something is weaker than a database that will not permit it.

**The `EventStore` port and its SQLite adapter**, in WAL mode. One adapter, not two: `add.md` §9 asks for an adapter that runs with no network, and SQLite's `:memory:` mode already is one — the real adapter with no disk rather than a second implementation of it. A separate in-memory `EventStore` was built here and removed; the two disagreed about whether a stored event could be edited in place, which is a Tier 0 property, and nothing caught it because each was only compared against itself. The in-memory pair stays load-bearing for the ports that reach a model, which arrive in Slice 2.

**The executor**, in its minimal form: takes a Command, validates it against the current aggregate, appends an event, returns. Optimistic concurrency on the aggregate version is built now (`add.md` §5.6) — the staleness *behaviour* is Slice 4's, but the version stamp has to be on the event from the first one.

**The upcast seam.** A version field on every event and a registry mapping (type, version) to an upcast function, with one registered identity upcast. The mechanism, not a library of functions.

**Snapshot machinery, switched off.** `runtime.md` §4.1 is explicit: keep the mechanism, set the cadence to never, revisit past ~1M events. The mechanism is the expensive part to add later; the cadence is a constant.

**One domain event type** to prove the path end to end. `CaptureIngested` is the natural choice since Slice 1 needs it anyway.

**The test framework and property-testing library**, chosen and standing. `stack.md` §8 records these as undecided, and Slice 0 is where the decision gets made because `qa.md` §12 step 3 — the Tier 1 pure tests — cannot start without a runner.

## Not in scope

- **The knowledge model.** No Person, Project, Idea, Event, or Task. Those arrive with the differ in Slice 3, against `schema.md`.
- **Projections of any kind.** Slice 5. The log is written and read directly here.
- **Anything probabilistic.** No `inference/` module has a body yet; the directory exists so the lint rule guarding it exists.
- **Tauri, the sidecar, and the UI.** The process model is stood up in Slice 1 where capture actually needs three processes. Slice 0 is a library and a test suite.
- **The SQLite driver decision** beyond what this slice needs — but note it must be able to load a binary extension (`runtime.md` §4.3), which constrains the choice made here even though the vector extension does not land until Slice 3.

## Build order

1. Repository skeleton, TypeScript configuration, test runner, property-testing library.
2. The four lint rules, wired to fail the build, with a deliberately-violating fixture proving each one fails.
3. `domain/events/` — event shape with type, version, aggregate, payload, provenance. Pure, no I/O.
4. The `EventStore` port, then its SQLite adapter with WAL and the UPDATE/DELETE triggers.
5. The executor: validate, append, return. Aggregate version stamped.
6. Upcast registry and the identity upcast.
7. Snapshot write/resume machinery, cadence constant set to never.

## Verification

Tier 0 (`qa.md` §4), at that tier's adversarial standard — this slice is almost entirely Tier 0:

- Each of the four lint rules fails the build on a violating fixture. These "should fail, not warn."
- `captures` and `events` have no UPDATE or DELETE path, asserted at the repository level and at the SQLite level independently (§4.1).
- Events are append-only; an attempted in-place payload edit fails at the storage layer (§4.4).
- Every event carries type, version, aggregate, and full provenance. A missing provenance field is a Tier 0 failure (§4.4).
- **No event carries a Confidence as a property of knowledge** (§4.4). The provenance records confidence at the time of inference; the knowledge does not carry one. Worth an explicit test — the distinction is subtle enough to erode.
- Every event version in the log has an upcast path to the current shape, and upcast functions are never deleted (§4.5).
- Property-based: appending the same event twice produces one event, not two (the idempotency substrate Slice 1 builds on).

## Done when

- A `CaptureIngested` event is appended through the executor and read back, carrying its full provenance and its aggregate version stamp.
- All four lint rules fail the build on their violating fixtures and pass on the real tree.
- SQLite rejects UPDATE and DELETE on `events` at the database level.
- The suite runs with no network, against SQLite in `:memory:`, touching no disk.
- `stack.md` §8's test-framework row is no longer open.
