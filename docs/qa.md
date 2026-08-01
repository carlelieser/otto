# Otto — QA Test Plan

> Status: accepted for MVP. Derives from [`prd.md`](./prd.md), [`add.md`](./add.md), [`triage.md`](./triage.md), [`schema.md`](./schema.md), [`runtime.md`](./runtime.md), [`salience.md`](./salience.md), and [`docs/adr/`](./adr/). Where this document and those disagree, they are right and this is stale.
>
> Otto has no implementation yet. This is therefore a plan for what to test and why, written so that it can be executed as the code lands, not a description of an existing suite.

## 1. What this plan optimises for

Otto is not a system where all bugs cost the same, and a plan that treats them as equal would spend most of its effort in the wrong place. Three properties of this system set the priorities.

**One failure is unrecoverable and the rest are not.** The event log and the Captures are the sole source of truth (ADR-0005), and every other table is derived and droppable (ADD §6). A corrupt projection is a rebuild. A corrupt log is the end of the user's knowledge base. That asymmetry is the single most important input to this plan: the tests guarding write-path integrity are not the same kind of test as the ones guarding a list view, and they get a different standard of rigour.

**The product metric is trust, and trust fails silently.** PRD §8 names the failure mode: the user stops believing the knowledge base, so they stop capturing, so it decays. The bug that causes this is not a crash — it is a confidently wrong auto-apply that the user believes and never checks. Crashes get reported; silent wrongness does not. So the tests that matter most are the ones that verify Otto *declined* to act, which is the hardest class of behaviour to notice missing.

**The middle of the system is probabilistic and cannot be asserted on.** An LLM read a note; the output is not a fixed value. This does not mean it is untestable — it means it needs a different instrument. The boundary is sharp and the architecture already draws it: extraction and adjudication are non-deterministic, and *everything else is deterministic by construction* (ADR-0007). The differ, the thresholds, the application policy, the executor, and the projections are all exactly-assertable. §5 covers the deterministic majority with ordinary tests; §6 covers the probabilistic minority with an eval set that measures rather than asserts.

### The ranking that follows

| Tier | What it protects | Failure cost | Standard |
|---|---|---|---|
| 0 | Log and Capture integrity, executor-as-sole-writer | Unrecoverable | Exhaustive, adversarial, property-based where possible |
| 1 | Triage, application policy, destructive-change gating | Recoverable but trust-destroying | Exhaustive over the rule table; every branch |
| 2 | Differ, projections, rebuild, redirects, provenance | Recoverable by rebuild | Thorough; property-based on rebuild determinism |
| 3 | Extraction and resolution quality | Degrades usefulness | Measured against the eval set, not asserted |
| 4 | UI, briefs, search, list views | Annoying | Smoke plus targeted cases around staleness |

The rest of this document is organised by tier, not by module, because that is the order in which the tests should be written and the order in which a failing one should stop a release.

## 2. What is deliberately not tested

Stated up front so the absences are decisions rather than gaps.

**Throughput, concurrency, and load.** ADD §1 makes scale an explicit non-goal, and ADD §4 serialises the pipeline to one Capture at a time. There is exactly one writer by construction (`runtime.md` §1). Writing concurrency tests for a system whose design eliminated concurrency would be testing a hypothetical. The one exception is §5.6's staleness handling, which exists because of *user think-time*, not parallelism, and is tested as such.

**Database swappability.** ADR-0001 is explicit that the layering buys testability, not swappability. No test will exercise a second database adapter, because there will not be one.

**Multi-user, sharing, sync, accounts.** PRD §6 and §7.3 rule these out permanently. No test surface.

**LLM output determinism.** Temperature 0 reduces variance; it does not guarantee identical output across model versions or providers. Any test asserting an exact extraction string is a test that will fail for reasons unrelated to Otto being broken. §6 measures aggregate quality instead.

**Vendor SDK behaviour.** The adapters are thin (ADR-0008). Testing that Anthropic's SDK returns what Anthropic's SDK returns is not Otto's job. What *is* tested is the adapter's translation into the port's vocabulary, and its behaviour when the vendor fails (§7).

## 3. Test levels and where each is used

Five levels, each earning its place by testing something the others cannot.

**Pure unit tests** — `domain/` and the pure functions in `inference/calibration/`. No I/O, no fixtures, no async. The application policy, the threshold table, the confidence combination, the redirect chain resolver, and the date-precision logic are all pure and all belong here. This is where Tier 1 lives, and it should be the fastest and largest part of the suite.

**Property-based tests** — for the invariants that must hold across *all* inputs rather than chosen ones. Rebuild determinism, redirect transitivity, idempotency under replay, and set-field union semantics are all statements of the form "for any sequence of events…", and example-based tests sample that space badly. This is the level most likely to be skipped and most likely to catch a Tier 0 bug.

**In-memory integration tests** — the whole pipeline, ingestion through triage, against the in-memory adapters ADD §9 requires. No network, no SQLite, no Tauri. This is the payoff ADR-0001 says the layering is actually buying, and it is where the pipeline's *sequencing* is tested: resumability, stage ordering, and what happens when a stage returns nothing.

**Persistence integration tests** — the same paths against real SQLite in WAL mode, because the in-memory adapters cannot exercise what `runtime.md` §4 measured. Projection rebuild, snapshot resume, and the two-process read/write split live here. The last of those matters more than it did before the spike: the spike was single-process, so UI-reads-while-worker-writes under WAL is the storage assumption that remains untested.

**End-to-end tests** — the Tauri application, driven through the UI. Deliberately few, and only for paths where the integration of the three processes is itself the thing under test: tray capture to durable Capture, and review-queue adjudication to applied event. E2E tests are slow and flaky by nature; every one of them must justify why it cannot be an integration test.

A note on ordering: **the SQLite spike (`runtime.md` §4) was a prerequisite, not a test.** It ran before schema work and answered whether the storage assumption holds at all; it passed on all seven bars. Those seven measurements are reproduced in §8 as a standing performance suite, because a spike that passes once and is never re-run is a spike that silently stops being true.

## 4. Tier 0 — Write-path integrity

The unrecoverable tier. Every test here is guarding a property whose violation cannot be repaired by a rebuild.

### 4.1 The executor is the only writer

ADR-0003 calls this the highest-value boundary in the tree, and ADD §3 makes three of the four layering rules lint-enforced from the first commit. Those lint rules *are* tests and belong in CI alongside the suite:

- No module under `inference/` imports a repository port, the event store port, or anything from `application/`.
- `domain/` imports nothing else in `src/`.
- Only the composition root imports `infrastructure/`.
- A grep for `confidence` under `domain/` returns nothing (ADD §3's fourth rule, the one that is not generally checkable but whose most likely violation is).

These are cheap, they fail loudly, and they catch the erosion ADR-0001 predicts will happen silently under time pressure. They should fail the build, not warn.

Beyond lint, one behavioural test: **`captures` and `events` have no UPDATE or DELETE path.** ADD §10 states there is no code path in Otto that updates or deletes a row in either table. This is verifiable directly — assert the absence at the repository level, and separately assert that the SQLite schema itself carries the constraint where it can (triggers rejecting UPDATE/DELETE on both tables). A test that the application layer does not do something is weaker than a database that will not permit it; do both.

### 4.2 Durability boundary at ingestion

ADD §11 puts the durability boundary as early as possible and synchronous with the user's action: the Capture is written before anything downstream runs, so a failure after that point is resumable and a failure before it loses the user's words.

Tests:

- A Capture is durably persisted before extraction is invoked. Assert ordering, not just eventual presence — inject a failure at the extraction stage and confirm the Capture survives.
- A crash between transcription and Capture persistence loses the audio, and this is *the accepted behaviour* — the test documents the boundary rather than asserting recovery. Worth writing precisely because a future change that moves work before the durability point would otherwise pass silently.
- Capture write failure surfaces to the user synchronously. Capture is the one path where the user is waiting, and silent loss here is the worst non-log failure in the system.

### 4.3 Idempotency under replay

`runtime.md` §3 gives the derivation directly:

```
capture_id  = hash(source, source_timestamp, content_hash)
proposal_id = hash(capture_id, stage, provider, model_version, ordinal)
```

Two behaviours fall out of one rule, and both need tests because they pull in opposite directions:

- **Same model, re-run → identical ids → no-op.** Re-running extraction for a Capture produces Proposals with the same ids; applying them twice produces one set of events, not two. Property-based: for any Capture and any number of replays, the resulting event log is identical to the single-run log.
- **New model version, re-run → new ids → ordinary Proposals.** The same Capture re-extracted under a different `model_version` produces *different* proposal ids that arrive as ordinary Proposals subject to ordinary triage. A test that asserts only the first behaviour would pass on an implementation that hashed away the model version, which is the bug `runtime.md` §3 is specifically written to prevent.
- **Double-delivered input produces one Capture.** A retried voice upload or a double-delivered email (post-MVP ingress, but the id derivation is MVP) yields the same `capture_id` and therefore one Capture.
- **A re-extracted Proposal matching current state closes silently** rather than appearing in the queue (`runtime.md` §3).

### 4.4 Event log append semantics

- Events are append-only; a test attempting an in-place payload edit fails at the storage layer.
- Every event carries type, version, aggregate, and provenance (Proposal, Capture, provider, model version, confidence at the time, human-confirmed flag) per ADD §10. A missing provenance field is a Tier 0 failure, not a cosmetic one — ADR-0006 notes that provenance which is not recorded at write time is unreconstructable later.
- **No event carries a Confidence as a property of knowledge.** `CONTEXT.md` and ADR-0002 both state that a confidence on anything past-tense means two concepts got merged. The provenance records the confidence *at the time of inference*; the knowledge does not carry one. This distinction is subtle enough to be worth an explicit test.

### 4.5 Event versioning and upcast

ADD §6 accepts event versioning as permanent discipline: payload shapes are never changed in place, a new shape is a new version with an upcast function, and upcasting happens at read time in the projection worker.

- Every event version present in the log has an upcast path to the current shape.
- A projection rebuild over a log containing mixed versions produces the same result as one over an all-current-version log with equivalent semantics.
- **Upcast functions are never deleted.** A test that enumerates historical versions and asserts each still has a handler. ADD §6 calls this the honest price of an immutable log; the test is what keeps someone from quietly stopping paying it.

## 5. Tier 1 — Triage and the gating of destructive change

This is where trust is won or lost, and it is almost entirely pure functions with zero I/O (ADR-0007). There is no excuse for incomplete coverage here.

### 5.1 The application policy rule table

`triage.md` §3 gives seven rows. Every row gets a test, and the table below is the checklist:

| Command kind | Expected | Test note |
|---|---|---|
| `create`, unambiguous mention | permit auto-apply | Candidate generation returned nothing above the noise floor |
| `create`, candidates existed and were rejected | downgrade to `needs_review` | The duplicate-producing case |
| `update` field, `auto` floor | permit | The ordinary case |
| `update` field, `review` floor | downgrade | `name` on any entity; `became` relations |
| `update` relation add | permit | Additive |
| `remove` field/relation/entity | downgrade, always | At any confidence, including 1.0 |
| `merge` | downgrade, always | At any confidence |
| `split` | downgrade, always | At any confidence |

Three properties of this function matter more than the individual rows:

**It may only downgrade, never upgrade.** Property-based: for any proposed disposition and any command kind, the policy's output is never less restrictive than its input. This one property catches a whole class of future bug that row-by-row tests would miss.

**It never reads a Confidence.** Structural, and checkable: the policy's signature does not accept one. ADD §3's grep for `confidence` under `domain/` covers the letter of this; a test that the function is called with a *kind of change* and nothing else covers the intent.

**It is pure.** No I/O, callable with no fixtures. If a test for the application policy needs a database, the policy is in the wrong place.

The destructive rows deserve emphasis: **`remove`, `merge`, and `split` are tested at confidence 1.0 specifically.** PRD §4.5 and ADR-0007 both state the rule as "never, at any confidence," and the only test that actually verifies "at any confidence" is one that passes the maximum and still expects a downgrade.

### 5.2 Confidence combination

`triage.md` §1:

```
p(correct) = p(extraction) × p(resolution)   -- when both apply
p(correct) = p(extraction)                    -- creates, and field changes on an already-resolved entity
```

- Both cases, including the boundary where a proposal involves no resolution judgement.
- The two confidences stay separate throughout the pipeline and are combined only at triage. A test that inspects a Proposal mid-pipeline and finds a single blended number is a failure — ADR-0007 keeps them apart because the failure modes differ.
- `p(resolution)` comes from the scorer, never the model's self-report. Specifically: **when LLM adjudication runs, the confidence is still the scorer's margin between the top two candidates** (`triage.md` §1). An adjudicated pick among near-identical candidates must not be more confident for having been adjudicated. This is a real and easy bug to introduce.

### 5.3 Thresholds

`triage.md` §2: `≥ 0.90` auto-apply, `0.50–0.90` review, `< 0.50` discard.

- Boundary values exactly: 0.90 auto-applies, 0.8999 reviews, 0.50 reviews, 0.4999 discards. Off-by-one at a threshold boundary is the classic bug and costs nothing to cover.
- **Thresholds are keyed by provider and model version** (ADR-0008). A test that two different model versions can carry different thresholds, and that a proposal is triaged against *its own* model's thresholds — not the currently-active model's. ADR-0008 calls retrofitting this genuinely painful, which means getting it wrong now is expensive later.
- Thresholds are loaded as data from `inference/calibration/thresholds.ts`, not scattered as literals. A grep test for numeric threshold literals elsewhere in `inference/` is cheap insurance.

### 5.4 Bootstrap mode

`triage.md` §4: until 50 Corrections have accumulated for the active provider and model version, `p(extraction)` is capped at 0.90 for triage purposes.

The consequence is the thing to test, because it is stated as a derived effect rather than a rule: **during bootstrap, only unambiguous creates and updates to already-resolved entities auto-apply.** Anything requiring a resolution judgement cannot reach the 0.90 band, because 0.90 × anything < 1 is below 0.90.

- A proposal requiring resolution, at maximum confidence on both figures, still does not auto-apply during bootstrap.
- Bootstrap is per provider and model version — switching models re-enters it, even if 50 corrections exist for the previous model.
- The 50th correction exits bootstrap; the 49th does not.
- Bootstrap status is visible in the dashboard (`triage.md` §4), not silent. A UI assertion, but the rule it surfaces is Tier 1.

### 5.5 Calibration sampling

`triage.md` §6, and ADR-0006 is emphatic that this cannot be reconstructed retroactively.

- Rates by correction count: 20% at 0–50, 10% at 50–500, 5% at 500+. Test the tier boundaries.
- Sampled proposals are marked as sampled and appear in the review queue **indistinguishably from ordinary ones**. Both halves matter: the mark must exist in the data for calibration to use it, and must not be visible in the UI, or the user's adjudication is biased by knowing they are being measured.
- **There is no off switch.** `triage.md` §6 is explicit that an instrument that can be disabled will be. A test asserting no configuration path disables sampling — including no environment variable, no settings toggle, and no debug flag.
- Statistical sanity: over a large synthetic run, the sampled fraction approximates the configured rate. Not an exact assertion; a range.

### 5.6 Staleness at apply time

ADD §5.6 and `triage.md` §8. Optimistic concurrency on the Proposal's aggregate version, needed because of user think-time.

- A Proposal whose target aggregate changed while it sat in the queue fails its version check and is re-proposed rather than applied blindly.
- **Re-proposal re-enters from the differ, not from extraction** — no LLM call. Assert the extractor port is not invoked.
- A re-proposal producing no change is **closed, not re-queued**. The user's own edit already satisfied it.
- A re-proposal producing a *different* change goes to review **regardless of confidence**, because the thing the user was looking at changed underneath them.

### 5.7 Discarded proposals remain visible

`triage.md` §7. Discards are recorded, not deleted; shown collapsed, default hidden, retained 30 days.

- A discarded proposal is retrievable and names its originating Capture.
- Retention: present at 29 days, absent after 30.
- No affordance exists to act on a discard beyond re-capturing. A test that the discard surface exposes no apply path — making discards actionable would turn the low band into a second review queue, which is what the threshold exists to prevent.

## 6. Tier 3 — Measuring the probabilistic half

Extraction and adjudication cannot be asserted on. They are measured against a fixed corpus, and the corpus is the instrument.

**The eval set is the gate** (ADR-0006, `runtime.md` §2). Its structure follows from ADR-0006's insight that a Correction records the counterfactual: each correction is an input/correct-output pair, and ~50 makes a regression suite rather than an anecdote.

### 6.1 What the eval set measures

Extraction is a pure function of the note text — it reads nothing but the text (ADD §5.2), and *that constraint is what makes it testable at all*. A stage that read current state would have output that changes as the database does, and no fixed corpus could pin it. This is worth stating in the plan because it means any future change letting extraction peek at the entity list destroys the eval set as an instrument, and should be treated as a breaking architectural change rather than an optimisation.

Metrics, per provider and model version:

| Metric | What it catches |
|---|---|
| Mention recall | Entities in the note that Extraction missed |
| Mention precision | Entities Extraction invented |
| Field-value accuracy | Right entity, wrong value |
| Schema violation rate | Fields not in `schema.md`; must be zero-tolerance, see below |
| Date resolution accuracy | Relative dates resolved against Capture timestamp |
| `date_precision` correctness | "next quarter" marked `quarter`, not `exact` |
| Resolution accuracy | Right entity chosen among candidates |
| Resolution bias direction | Ratio of wrong-match to none-of-these errors |
| Calibration curve | Of proposals scoring 0.85, how many were right |

**Resolution bias direction is the one to watch.** ADR-0007 and ADR-0009 both bias resolution toward "none of these" over a wrong match, because a duplicate is recoverable and a misattribution quietly corrupts knowledge. So the eval set must report these as *separate* error classes, not a single accuracy number. An implementation that improved overall accuracy while shifting errors from "none" toward "wrong match" would look better on a blended metric and be worse for the product.

**The calibration curve is a test of the confidence, not of the extraction.** ADR-0006's whole argument is that self-reported LLM confidence is a token distribution rather than a probability. The curve is what checks it, and its input is the correction log — which is why §5.5's sampling has no off switch.

### 6.2 Corpus construction

The eval corpus must contain the cases the design says are hard, not just representative notes:

- Notes mentioning entities that do not exist yet (the unambiguous-create path).
- Notes mentioning a name that matches an existing entity but is a *different* person (the review-triggering create, `triage.md` §3).
- Two notes mentioning the same new entity, to confirm serialisation prevents a race (ADD §4).
- Names a small transcription model gets wrong — `runtime.md` §2 names proper-noun recall as the metric that matters, not general WER.
- Relative dates of every precision, including `relative_unresolved` ("when the contract lands").
- Notes whose content fits no typed field, to exercise the `notes` pressure valve (`schema.md` §7).
- Notes pushing an enum outside its closed set, expecting `other` plus a `notes` entry.
- Empty, single-word, and very long notes.
- Notes containing no extractable entity at all — a valid outcome that must not produce a spurious Proposal.

### 6.3 The local-inference floor

`runtime.md` §2 names this as the single most likely technical assumption in Otto to be wrong: schema-constrained extraction from a 7–8B model. Grammar-constrained decoding guarantees parseable output, not correct output.

The floor to clear, stated as a pass condition: **the local path produces a usable knowledge base with more review friction, not a corrupted one.** Operationally that decomposes into:

- Schema violation rate at or near zero (grammar constraints should guarantee this; if they do not, the constraint is misconfigured).
- Field-value accuracy worse than cloud, by a measured margin rather than an assumed one.
- **More proposals landing in review, not more wrong proposals auto-applying.** This is the degradation the design intends: lower confidence → more review. A local run whose auto-apply rate matches cloud's is a red flag, not a success.

If the local model cannot clear this, `runtime.md` §2 states the honest response is to raise the minimum local model size rather than loosen thresholds. The eval set is what makes that call with data.

### 6.4 Transcription

- Name accuracy specifically, not general WER (`runtime.md` §2).
- The projection-names-as-initial-prompt mitigation measurably improves proper-noun recall — test with and without, since the mitigation is only worth its complexity if it does.
- Latency ≤ 2× realtime on the target machine class.

## 7. Tier 2 — Projections, provenance, and the read path

Recoverable failures, tested thoroughly but without Tier 0's adversarial standard.

### 7.1 Rebuild determinism

ADR-0005 makes rebuild routine rather than a disaster-recovery step, and ADD §11 says a corrupt projection is boring. That is only true if rebuild is reliable, which makes this the load-bearing test of the entire projection design.

- **Property-based: for any event log, dropping every projection and rebuilding produces byte-identical projection state.** This single property is worth more than any number of example-based projection tests.
- Rebuild from a snapshot equals rebuild from event zero (ADD §6).
- A corrupt or stale snapshot is recoverable by deleting it and replaying fully — snapshots are themselves derived and disposable.
- Rebuild is interruptible and resumable; a crash mid-rebuild does not leave a partially-populated projection presented as complete.

### 7.2 The differ

No LLM, fully deterministic, and the stage where hallucination is structurally prevented (ADD §5.4). Every rule is exactly assertable.

- **Cardinality from the schema** (ADR-0010, `schema.md` §1): a `single` field with a new value produces a supersession; a `set` field unions and **never silently drops a member**.
- Per-field floors are read from `schema.md`, not hardcoded in the differ.
- **Derived fields can never appear in a Proposal.** `salience` and `last_contact_at` are computed by projection. If the extractor emits one, it is dropped and **the drop is logged as a schema violation, not accepted quietly** (`schema.md` §1). Both halves tested: the drop, and the log.
- Unknown field names are rejected at parse time, before the differ (ADD §5.2, `schema.md` §7). The extractor's output schema is generated from the schema tables, so this should be structurally impossible — test that it is.
- Dependent fields: `blocker` is cleared by a status change away from `blocked` (`schema.md` §4).
- No-op diff produces no Command.
- **The model never emits a Command.** Structural, and the reason invented ids and hallucinated field names are impossible. Worth an explicit test of the seam.

### 7.3 Relations

`schema.md` §6. The vocabulary is closed and typed by the pair of entity types it connects.

- Each of the seven relations accepts only its declared from→to type pairs; a `knows` between a Person and a Project is rejected.
- Cardinality: `became` is `single`, the rest are `set`.
- `became` carries a `review` floor and never auto-applies.
- `knows` is **only recorded when a note says so, never inferred from co-occurrence** — an easy and tempting bug that would fill the graph with noise.
- Removing a relation is a `remove` Command and never auto-applies (§5.1).
- Monitoring, not assertion: `relates_to` dominating the graph is the signal the vocabulary is too small (`schema.md` §6). Worth a reported metric rather than a failing test.

### 7.4 Merge and redirects

`triage.md` §5 pulls a minimal merge into MVP; split stays deferred. Test what ships.

- `EntitiesMerged` produces one entity in the projection; the merged-away id does not appear in any list view.
- **Redirects are transitive.** ADR-0009's own example: merge #4891 into #4172, later #4172 into #5310, and #4891 must resolve to #5310. Property-based over arbitrary chain lengths, because "follows chains rather than assuming one hop" is precisely the bug a one-hop implementation passes an example test for.
- A proposal queued *before* a merge, approved a week after, resolves through the redirect and applies to the survivor — without the merge having touched the review queue.
- Provenance display for a pre-merge event whose target is immutably the old id resolves to the survivor.
- Field conflicts keep the survivor's value and move the loser's into `notes` — lossless (`triage.md` §5).
- Nothing in history is rewritten: `PersonCreated(#4891)` and every event against #4891 remain exactly as they were.
- Duplicate detection is a projection surfacing suspected-duplicate pairs into the review queue.
- **Split is not implemented in MVP.** Test that no split path exists rather than testing split behaviour.

### 7.5 Provenance

ADD §7 calls this the read that justifies the whole log, and PRD §5.3 requires every fact traceable to its note.

- **Every field on every entity view names the event that last set it**, and through it the Proposal, Capture, model and version, confidence, and human-confirmed flag. Property-based: for any entity in any projection state, no field lacks a provenance pointer.
- The pointer is built during projection, not reconstructed by scanning the log (ADD §7).
- Provenance survives merge (§7.4) and transcript correction (§7.6).
- A user-confirmed fact is distinguishable from an auto-applied one.

### 7.6 Transcript correction

`runtime.md` §5. The collision between immutable Captures and imperfect transcription.

- Correcting a transcript appends `CaptureTranscriptCorrected`; **the original is never overwritten** and both texts remain readable.
- The corrected text becomes what Extraction reads.
- Correction re-runs the pipeline for that Capture — **the one case where re-extraction is automatic**.
- Provenance after correction names the corrected text as what produced the fact.
- **Typed Captures are not editable.** They were not misheard, and editing them would be note-editing, which PRD §6 excludes. Test the absence of the affordance.

### 7.7 Corrections

ADR-0006, PRD §5.5.

- A correction records **what the user chose instead**, not a boolean rejection. The counterfactual is attached to the Proposal that got it wrong and the Capture behind it.
- A correction is a compensating event; nothing is deleted and history stays intact.
- Correcting is one action from the review queue and does not require navigating to the entity (PRD §5.4).
- The correction path issues a Command directly to the executor and **does not re-enter the pipeline** (ADD §7).

## 8. Performance and the storage assumption

`runtime.md` §4's spike measurements become a standing suite, run against the synthetic corpus (10,000 Captures, ~50,000 events, ~3,000 entities, ~10,000 relations — biased heavy so a pass means comfortable). The spike's own results are the first baseline; the harness that produces them lives in `spikes/sqlite/` and is the suite.

| Measurement | Baseline | Pass | Fail |
|---|---|---|---|
| Full projection rebuild from event zero | 215 ms | ≤ 60 s | > 5 min |
| Incremental catch-up, 100 events | 11.6 ms | ≤ 500 ms | > 2 s |
| Entity view query — row + relations + provenance | 0.1 ms | ≤ 50 ms | > 200 ms |
| Vector search over 3,000 entities, top-20 | 0.3 ms | ≤ 100 ms | > 500 ms |
| Full-text search over 10,000 Captures | 1.7 ms | ≤ 100 ms | > 500 ms |
| Event append with WAL, sidecar writing | 0.1 ms | ≤ 10 ms | > 50 ms |
| Database size on disk | 47.8 MB | ≤ 2 GB | > 10 GB |

Between pass and fail is the band where the design holds but needs attention. Treat a result in that band as a warning that gets recorded, not a green build.

**The baselines matter more than the bars now.** Every bar passes by 20× or better, which means the bars alone will not catch a regression until it is catastrophic — a rebuild that gets 100× slower still passes. Watch movement against the baseline column, not distance from the fail column.

**A performance result is only meaningful if the thing being timed did its job.** A rebuild that silently no-ops is very fast. The suite therefore carries correctness checks alongside the timings — projections populate, single-valued fields hold the last event's value, a second rebuild is byte-identical to the first, partial-plus-catch-up equals a full rebuild, provenance resolves through to model and confidence. These caught two corpus bugs during the spike that would have made its numbers meaningless.

Two notes carried from `runtime.md` §4: **vector search was the predicted failure and was not** — it passes by 330×, and the separate-index fallback is not being built, though it stays cheap to reach for because embeddings are derived state. **If several bars fail together, the answer is not a different database** — it is that the projection model is doing too much work per event, which is a design finding rather than a test failure. That remains the most likely way this suite goes red, since the real projector does more per event than the spike's did.

Additionally, the capture-latency budget is a product requirement, not a nice-to-have: PRD §4.1 makes cheap capture the first principle, and ADD §4 requires the UI never run pipeline work. Test that **capture round-trip stays responsive while the pipeline is saturated** — a long extraction against a local model must not make the capture window stutter. This is the test that guards the entire process-model decision in `runtime.md` §1.

## 9. Failure and degradation

ADD §11's four failure modes, each with the behaviour that must hold.

**The LLM is unavailable.** Capture still works — it is the one path with no inference in it. Captures accumulate at the extraction stage and drain when a provider returns. The user loses timeliness, never data. Test with the provider adapter failing, timing out, rate-limiting, and returning malformed output — four distinct failures that must degrade identically.

**The sidecar crashes.** The supervisor restarts with backoff (`runtime.md` §1). Because the pipeline is resumable per stage, a restart **resumes rather than replays** — a crash after extraction must not re-bill the LLM call. A crash loop degrades to "captures accumulate," the same state as an unavailable provider. Test the crash-loop path explicitly; it is the one that turns into a support question.

**A projection is corrupt.** Delete and rebuild, covered by §7.1. The test here is that the *application* handles a missing projection gracefully rather than erroring at the UI.

**The log is corrupt.** The only unrecoverable failure. There is no recovery test; there are the Tier 0 tests that prevent it, plus a corruption-detection test that fails loudly rather than continuing on a partially-readable log.

**Restartability.** PRD §4.7: a week away creates no backlog to clear. Test a week's worth of Captures accumulated at mixed pipeline stages, and confirm they drain without user action and without duplicate proposals.

## 10. Tier 4 — Interface

Deliberately the thinnest section. The UI is where bugs are most visible and least costly, and E2E tests are the most expensive per unit of confidence.

**Staleness tolerance is the one non-obvious behaviour and gets real tests.** ADD §6 states that every read surface tolerates a projection lagging the log, and that the dashboard handles this by treating an applied event as immediately true in the local view rather than blocking on the projection catching up. Test: approve a proposal, assert the UI reflects it immediately, assert it still reflects it after the projection catches up, and assert it does not double-apply or flicker.

**Smoke coverage** for: tray capture (voice and typed), dashboard navigation across all five entity types plus notes, list search/sort/filter, entity detail with relations and provenance, review queue with confirm and correct, and the daily and weekly brief surfaces.

**E2E, and only these:** tray hotkey to durable Capture (the three-process integration), and review-queue adjudication to applied event (the full write path through the UI). Everything else is an integration test.

**Accessibility and cross-platform** are smoke-level: the application launches, the tray works, and the hotkey binds on macOS, Windows, and Linux. Otto is single-user desktop software; browser matrices do not apply.

## 11. What blocks parts of this plan

Honest about what cannot be written yet.

**Salience v0 is testable, but only as arithmetic.** The selection rules now exist (`salience.md`, ADR-0015): a sum of five named terms, each with stated coefficients. That makes the score exactly assertable — given a fixture entity with a known mention date, status, and due date, the score is a number, and each term can be tested in isolation. Brief composition is likewise assertable at the selection stage: given a fixture knowledge base, which entities land in which section, and that caps hold and empty sections are omitted.

What remains untestable is whether the rules are *right*, which is a product question no test can answer and which `salience.md` §5 addresses with instrumentation instead. So §10's brief tests stay smoke-level for the generated prose — a brief generates, is non-empty, contains no entity that was not selected (ADD §8) — while the selection beneath it gets ordinary Tier 1 treatment.

The architectural commitment is tested separately and matters more than either: salience is a projection, recomputable from history, writing nothing (ADD §8). Test that changing the rules and recomputing produces a new ranking from the same log — that property is the entire reason salience was made a projection, and it is what makes v0's expected replacement cheap.

**Split has no tests because split has no MVP implementation** (`triage.md` §5, ADR-0009). Its semantics are settled, including the default disposition — unclassified values stay with the original identity — so the tests are writable when the implementation lands, not blocked on a decision. **Merge does have tests**, since minimal merge is in MVP scope (ADR-0012): transitive redirect resolution is the property worth the most rigour there, per §7.

**The auto-apply sampling rate** is settled at 20/10/5% (`triage.md` §6, ADR-0012). The tests in §5.5 assert the mechanism and the configured tiers; if the rate changes, the tier boundary tests change with it, which is a one-line update by design.

## 12. Execution order

The order matters because some of these are prerequisites for the others being meaningful.

1. ~~**The SQLite spike** (`runtime.md` §4). Before schema work. It may change the design.~~ **Done — passed on all seven bars; the design is unchanged and schema work is unblocked.** Its harness (`spikes/sqlite/`) becomes the §8 suite.
2. **Lint rules** (§4.1). From the first commit, per ADR-0001 and ADR-0003. Cheapest tests in the plan and they guard the most important boundary.
3. **Tier 1 pure tests** (§5). Pure functions, no fixtures, writable before any infrastructure exists. Highest value per unit of effort in the entire plan.
4. **In-memory adapters and pipeline integration** (§4.3, §7.2). ADR-0001 says this is what the layering is buying; it should be built early enough to actually collect on that.
5. **Tier 0 property tests** (§4). As soon as the event store and executor exist.
6. **Eval set** (§6). Needs ~50 corrections to be a regression suite rather than an anecdote, which means it starts as a hand-built corpus and grows from real corrections. Start hand-built; do not wait for organic data.
7. **Projection and rebuild property tests** (§7.1). As soon as projections exist.
8. **Performance suite** (§8). Standing, from the point real SQLite is in play.
9. **UI smoke and the two E2E paths** (§10). Last, and kept small.

## 13. Release criteria

A build ships when:

- Every lint rule in §4.1 passes. Not negotiable — these encode ADR-0003.
- Tier 0 and Tier 1 are green with no skipped tests. A skipped destructive-change test is a release blocker.
- Eval set metrics have not regressed against the previous release, per provider and model version. A regression is a hold, not a warning — ADR-0006 notes that without this the pipeline rots silently.
- The local path clears the §6.3 floor.
- No performance measurement is in the fail column; measurements in the warning band are recorded.
- The two E2E paths pass.

And a standing rule that follows from the whole shape of this plan: **a test asserting Otto declined to act is as important as one asserting Otto acted.** The failure this system dies of is not a crash. It is a confidently wrong change the user believed.
