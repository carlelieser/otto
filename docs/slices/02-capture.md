# Slice 2 — Capture

> Depends on: Slice 1. Blocks: Slice 3.
> Sources: [`prd.md`](../prd.md) §5.1; [`add.md`](../add.md) §5.1, §9, §11; [`runtime.md`](../runtime.md) §2, §3, §5; [`qa.md`](../qa.md) §4.1, §4.2, §4.3, §6.4, §8; ADR-0013.
> Decisions taken here are recorded in [ADR-0018](../adr/0018-voice-ingestion-is-one-call.md).

## What it closes

The user presses a hotkey, speaks or types a thought, and it is durably stored as an immutable Capture. Nothing reads it yet — but the words are safe, which `add.md` §11 identifies as the one thing Otto can genuinely lose.

This is the first slice with a user in it. Slice 1 built the three processes; this is the first thing they carry.

## Why here

Capture is the only stage with no inference in it, which makes it the only one that can be built and verified before any model exists. It is also where PRD §4.1's first principle lives: if capture costs more than a few seconds the user will not do it consistently and everything downstream is worthless. Building it first means the latency budget is a constraint the rest of the system is built under rather than one it is measured against at the end.

It comes directly after the runtime because the runtime has nothing to carry until it does, and because the capture window Slice 1 opens has nowhere to write until `CaptureStore` exists.

## In scope

**Typed capture, end to end.** The capture window Slice 1 opened now stores what it is given. The simpler of the two paths and the one that proves the durability boundary without a model in the way. One note per thought — no title, no category, no tags (PRD §5.1).

**Voice capture and transcription.** `whisper.cpp` with `small.en`, bundled, via the `Transcriber` port (`runtime.md` §2). The one port where local is non-negotiable — a capture path requiring a network is not a local-first system. Budget: ≤ 2× realtime on an 8-core consumer machine. Slice 1 built the recording and the path handoff; this slice puts a transcriber at the far end of it.

**Transcription runs in the Node sidecar, not the Rust host.** Audio capture is Rust because that is where the OS APIs are; transcription is not, because `add.md` §9 puts it behind a port and `ports/` is a TypeScript directory. Putting the adapter in Rust would place a port implementation in a language with no ports directory and no lint rule watching it, which is how the boundary Slice 0 enforces gets quietly holed.

**How the sidecar invokes `whisper.cpp`: by shelling out to the `whisper-cli` binary**, not through a Node native binding. The adapter spawns a process, passes the audio path and the model path, and reads the transcript from its output. A native binding buys in-process speed that a port taking a file path cannot use anyway, and costs a compiled dependency rebuilt per Node version and per platform — on top of `better-sqlite3`, which is already one. Shelling out also keeps the adapter honest: everything it needs is behind the `Transcriber` signature, and swapping the binary for `large-v3` is a path change (`runtime.md` §2). `stack.md` §8 records this.

**The `CaptureStore` port** and its SQLite adapter, separate from the `EventStore` because Captures are input, not change (`add.md` §9). One adapter — `:memory:` is the offline mode for a storage port.

**The `captures` table, reshaped.** Slice 0 already created it with its insert-only triggers, and this slice changes its shape: Slice 0's single `text` column becomes `raw_text`, and a nullable `corrected_text` is added. The repository-level half of `qa.md` §4.1's pair lands here too, since it could not be written without the port.

A third column, `transcription_model`, records what produced a voice Capture's text — `NULL` for a typed one, and for a voice one the model name exactly as `whisper.cpp` names it, e.g. `small.en`. Not a display label, not a path, and not the binary's version: the model is what a later re-transcription decision turns on. It sits here rather than in Provenance for the reason given below: it describes the input, not an inference whose thresholds need calibrating.

It is outside the `capture_id` hash. Two recordings of the same audio under different transcription models are the same Capture — the input did not change, only what read it.

**Reshaping it is a migration, and this slice does it by editing `CREATE_SCHEMA` in place.** That is worth stating plainly rather than calling the change additive, because it isn't. There is no migration mechanism in the repository and this slice does not build one: `CREATE_SCHEMA` uses `CREATE TABLE IF NOT EXISTS`, so a developer's existing database would silently keep the old shape and fail at the first insert against a column that isn't there. Any pre-Slice-1 database is disposable — nothing has shipped, no Capture in one is worth keeping — so the migration procedure is "delete the file." A real migration mechanism arrives when there is a real user's database to protect, which is Slice 11 at the earliest.

The distinction that *does* hold is the one about Slice 9. `corrected_text` stays `NULL` for the whole of this slice and is the field Slice 9 writes, which is what makes that slice an append rather than a second reshaping (`runtime.md` §5). Declaring the column now costs one nullable column while the database is still disposable; discovering it in Slice 9 costs a migration at the point where one might actually be needed.

**What `raw_text` holds, exactly: the text before any of the three normalisation rules ran.** For a voice Capture that is the transcriber's output verbatim, whitespace and all; for a typed one it is the keystrokes as submitted. Nothing trims it, nothing collapses it, nothing runs NFC over it. This is worth stating rather than leaving to inference from "raw," because `content_hash` is computed over this column and getting it wrong changes every id in the system.

Normalised text is not stored. It is derived from `raw_text` by a pure function, and a stored copy would be a second truth that can disagree with the first. `CaptureIngested`'s existing `text` field carries the normalised form for downstream consumers, and its payload gains no correction field — the corrected text arrives on `CaptureTranscriptCorrected` in Slice 9, per `add.md` §5.1, and duplicating it onto the ingestion event would mean two events claiming the same fact.

The three columns therefore hold three different things, and only one of them is derived: `raw_text` is input, `corrected_text` is a later human input, and the normalised form is neither — it is computed on read from whichever of the two is current.

**Idempotency, keyed on the Capture.** `runtime.md` §3 gives the shape; naming a hash function is not enough to make two implementers agree, so the derivation is written out to the byte.

```
content_hash = sha256_hex(raw_text)                       // 64 chars, no prefix
capture_id   = "cap-" + sha256_hex([
                 source,
                 source_timestamp,
                 content_hash
               ].join(" ")).slice(0, 32)
```

Every term of that, stated rather than implied:

- **`sha256_hex` is SHA-256 over the UTF-8 encoding of its input, rendered lowercase hex.** Both halves are load-bearing: an unstated encoding means a Capture containing an em-dash hashes differently on two machines, and unstated case means half an implementation compares hex that never matches.
- **The separator is a single space and the field order is exactly as listed.** `deriveEventId` joins with `" "` (`application/pipeline/event-identity.ts`), and matching it is the point — but "matches `deriveEventId`" is a pointer, not a specification, so the separator and the order are given here directly. Two implementers reading only a pointer produce two id schemes and no dedup.
- **`content_hash` is the full 64 characters; `capture_id` truncates to 32 after the `cap-` prefix.** Different widths for different reasons: the id is truncated to match `deriveEventId`'s `ID_LENGTH`, and the content hash is not truncated because nothing requires it to be and a full digest costs nothing in a `TEXT` column. Neither carries an algorithm prefix — no `sha256:`.
- **`content_hash` is over `raw_text`, before normalisation.** Normalisation is a pure function of the raw text, so hashing the raw form is strictly more discriminating, and it keeps the key stable if the normaliser is ever changed — hashing normalised text would silently re-key every existing Capture the day whitespace handling is touched.

  The cost is worth naming: because NFC runs in normalisation rather than before the hash, the same visible text in two Unicode forms is two Captures. That is accepted. It is vanishingly rare from a single user on one machine with one keyboard and one transcriber, and the alternative — normalising before hashing — puts the normaliser inside the id derivation, where changing a rule re-keys the corpus. A stable key with a rare false negative beats an unstable one.
- **`source` is the literal string `"typed"` or `"voice"`.** A closed set of two; it is part of a hash input, so it cannot be a display label somebody later capitalises.
- **`source_timestamp` for a voice Capture is when recording *started*.** Recording end and transcription-completion are both wrong, and wrong in a way that breaks the retried-upload test in Verification: transcription is non-deterministic in duration, so a re-upload of identical audio would produce a different timestamp and therefore a different `capture_id` — a duplicate Capture from the same input, which is exactly what §4.3 forbids. Recording start is a property of the input; the other two are properties of the run.
- **`source_timestamp` is ISO 8601, UTC, exactly `YYYY-MM-DDTHH:MM:SS.sssZ`.** Millisecond precision always, trailing zeros retained, `Z` rather than `+00:00`. The same instant formatted two ways hashes two ways, so the format is fixed rather than merely described.

**The `proposal_id` derivation, in full.** `runtime.md` §3 gives `proposal_id = hash(capture_id, stage, provider, model_version, ordinal)`. Nothing produces one until Slice 3, but it is specified here because the two derivations have to be read together — they are deliberately different, and the difference is the whole of `runtime.md` §3:

```
proposal_id = "prop-" + sha256_hex([
                capture_id,
                stage,
                provider,
                model_version,
                String(ordinal)
              ].join(" ")).slice(0, 32)
```

- **Same digest, same separator, same truncation, same prefix convention.** Only the field list differs.
- **`stage` is the pipeline stage that produced the Proposal** — `"extraction"` or `"resolution"` in MVP, a closed set extended only by a slice that adds a stage.
- **`ordinal` is the Proposal's zero-based index within its stage for that Capture**, in the order the stage emitted them. It is what keeps two Mentions from one Capture, one model, and one stage from colliding. Rendered with `String()`, so `0` not `"0.0"`.
- **`provider` and `model_version` are in the hash on purpose**, and this is the half that pulls against the other. A retry under the same model produces identical ids and is a no-op; a re-run under a *better* model produces new ids and therefore new Proposals, which is correct — a better model should be able to say something new about an old Capture (ADR-0011). An id derived from the Capture alone would make re-extraction silently impossible.
- **`capture_id` is not in `proposal_id`'s truncation budget twice.** The full 36-character `cap-`-prefixed id goes in as a string; it is not re-hashed or stripped first.

**Provenance on `CaptureIngested`, where no inference happened.** The executor requires a `Provenance` with a non-empty `provider` and `modelVersion` (`domain/values/provenance.ts`), and ingestion has no model to name. Both capture paths use `humanConfirmedProvenance` — `provider` and `modelVersion` both `"human"`, `confidence: null`, `isHumanConfirmed: true`, `proposalId: null`.

**Voice does not record `whisper.cpp` as the provider**, which is the tempting answer and the wrong one. `provider` and `modelVersion` are the key `triage.md` §2 uses for thresholds and §4 uses to count Corrections toward bootstrap exit. A transcriber never proposes anything and has no Confidence to calibrate, so a `whisper.cpp` cohort would be a bootstrap bucket that can never fill and a threshold row that is never read. The field means *the inference provider whose judgement this record is calibrating*, and transcription is not a judgement about knowledge — it is how the user's words arrived.

`isHumanConfirmed: true` is right for the same reason. It does not assert the transcript is accurate; it asserts nothing unattended decided anything. The user typed or said this, and no inference stands between them and the Capture. A misheard name is a wrong Capture, not an unconfirmed one — which is exactly why correction is its own event in Slice 9 rather than a Confidence here.

What model transcribed a Capture is still worth knowing, and it belongs on the Capture rather than in Provenance. The `captures` row records the transcription model alongside `source`, where it describes the input rather than an inference. Nothing in the MVP reads it — Slice 9 excludes re-transcription — so it is recorded because it cannot be reconstructed afterwards, the same reasoning ADR-0006 applies to provenance generally. A `large-v3` upgrade someday needs to know which Captures came from `small.en`, and by then the answer is unrecoverable if it was never written down.

**It does not go on `CaptureIngestedPayload`**, which is worth stating rather than leaving to be inferred from its absence above. The column is its one home. Adding it to the event payload as well would be a third place the same fact lives — after the row and the model file itself — and the rule against that is the same one that keeps corrected text off this payload: two records of one fact are two records that can disagree. Nothing downstream reads the transcription model in the MVP, so there is no consumer the event would be serving; the slice that first needs it can read the `captures` row, which is where the sweep and the id derivation already look.

**Slice 0's test fixtures contradict this and are corrected here.** `tests/support/builders.ts` builds a Capture's Provenance with `provider: "local"`, `modelVersion: "qwen2.5-7b-instruct"`, `confidence: 0.92`, and `proposalId: "prop-1"` — an extraction's provenance attached to an ingestion event. It is well-formed, so nothing failed; it was a placeholder written when `CaptureIngested` existed only to prove the write path had two ends. Adopting it by imitation is the likely failure mode, since it is the only worked example in the repository. `aProvenance` stays as it is for the inference slices that will need it, and the Capture builders switch to `humanConfirmedProvenance`.

Two smaller corrections in the same area, both cheap now and awkward later:

- **`CaptureIngestedPayload.contentHash`'s doc comment describes it as `hash(source, sourceTimestamp, contentHash)`** (`domain/events/capture-ingested.ts`), which defines the field in terms of itself. It is an *input* to `capture_id`, not the key. The comment is wrong rather than the field.
- **The fixture's `"sha256:abc123"` is not a value this slice's derivation can produce.** No hash in Otto carries an algorithm prefix, and `content_hash` is 64 hex characters. Fixtures that cannot occur in production are how an assumption about format survives until something parses it.

**The sidecar's two ingestion methods, and why voice is one call rather than two.** Slice 1 left a `readAudio` method at the far end of the path handoff, which read the file, reported its size, and deleted it. This slice replaces it with `ingestVoice`, and adds `ingestTyped` as its sibling. Both return the resulting Capture.

`ingestVoice` transcribes, ingests, and *then* deletes, in one call. The alternative — a `transcribe` call followed by a separate `ingest` call — puts the durability boundary between two round trips, which opens a second crash window on top of the one Verification below accepts. That accepted window exists between transcription and persistence *within* a single handler; splitting the call widens it into a gap the host is responsible for closing, and the host is the process with no database access at all. One call keeps the boundary where §4.2 of `qa.md` put it.

This is not a new decision so much as the one Slice 1 deferred: it said the sidecar "deletes after a successful *read* in this slice, and Slice 2 moves the delete point later in the same handler once transcription sits in front of it." Renaming the method is what that move looks like when it lands. Slice 1's ownership rule is unchanged — the host writes the temporary file, the sidecar deletes it, and the supervisor sweeps orphans — only the definition of "successful" moves from a completed read to a completed ingestion.

**The host passes recording-start time with the path.** `source_timestamp` for a voice Capture is when recording started (above), and recording start is a fact only the host knows: it is the instant `Recording::start` opened the input device (`src-tauri/src/audio.rs`). Nothing in Slice 1's transport carries it — the path handoff passes a path and nothing else — so `ingestVoice` takes both, and the host formats the timestamp to the exact `YYYY-MM-DDTHH:MM:SS.sssZ` shape specified above before sending it.

The failure mode worth naming: a sidecar that defaults to its own clock when the field is absent produces a `source_timestamp` that is transcription-completion time wearing recording-start's name, and the retried-upload test in Verification then passes on a fast machine and fails on a slow one. So the field is required rather than defaulted — a missing `sourceTimestamp` is an error, not a shrug.

**Ingestion, and its hard rule.** Transcription, whitespace and transcript cleanup, timestamping, deduplication — and nothing semantic. `add.md` §5.1 uses date-noticing as the specific example of what ingestion must not do. The temptation is constant and moving it earlier turns a normaliser into a second, undisciplined extractor.

**Both methods share one ingestion path.** `ingestVoice` and `ingestTyped` differ in how they obtain text and in what `source` they set; everything after that — normalise, timestamp, derive `capture_id`, write the row, build the Command, call the executor — is one internal function both call. Build order step 4 specifies that sequence precisely because getting it backwards produces a system that works until the first crash, and two call sites each remembering the order is two chances to get it wrong instead of one.

**Normalisation, exhaustively.** "Whitespace and transcript cleanup" needs a closed list, because a normaliser with an open brief is the second extractor `add.md` §5.1 warns about. It does exactly three things, in this order:

1. **NFC.** Unicode canonical composition, applied first so the two whitespace steps see composed characters.
2. **Collapse** every run of one or more whitespace characters to a single U+0020 space. "Whitespace" means Unicode whitespace, not just ASCII — a non-breaking space from a paste is whitespace. Newlines collapse too: a Capture is one thought, not a document, and preserving line structure would be preserving a formatting decision the capture window does not offer.
3. **Trim** leading and trailing spaces.

Nothing else — no punctuation repair, no capitalisation, no filler-word removal, all of which require deciding what the user meant.

It is a pure function in `capture/`, and it does not feed `content_hash`, which covers raw text. That combination is what makes the list safe to extend later: adding a rule changes what downstream reads without re-keying a single existing Capture.

**The Capture is its own aggregate, and `capture_id` is the aggregate id.** `CaptureIngested` is always version 0 of a new aggregate, so `expectedVersion` is 0 for every ingestion. Slice 9's `CaptureTranscriptCorrected` is what gives the Capture aggregate a version 1.

**The staleness check is not inert here, and this was wrong when first written.** An earlier draft of this section claimed `#rejectIfStale` could only fire if the same Capture were ingested twice *concurrently*, which the single-threaded pipeline (`add.md` §4) prevents. That is false, and the implementation found it: a *sequential* re-ingestion fires it too. The second delivery arrives with `expectedVersion: 0` against an aggregate already at version 1, and `StaleCommandError` is thrown before `EventStore.append` gets the chance to no-op it.

That matters because the retried voice upload in Verification is exactly this case, and §4.3 requires it to be a no-op rather than a throw. The store's idempotency does not save it: the executor's check sits in front of the append. So ingestion asks whether the Capture's ingestion event already exists before building the Command, and returns if it does.

The executor is left alone. Its staleness check is correct — Slice 4 turns a `StaleCommandError` into re-proposal from the differ — and weakening it to make ingestion convenient would trade a real guarantee for one caller's shape. The idempotency belongs at the call site that knows re-ingestion is legitimate.

**Ordering: the Capture row is written before the event.** Two separate ports with no shared transaction (`add.md` §9), so one of the two orders has to be chosen and the crash between them accounted for.

The row goes first. A `captures` row with no `CaptureIngested` event is a Capture the log does not mention — invisible to the pipeline, and recoverable, because the row holds everything the event's payload needs and re-running ingestion for it produces the identical `capture_id` and therefore the identical `eventId`. The reverse order fails worse: an event pointing at a row that does not exist is a dangling reference in the one table that is truth, and the log cannot be repaired without violating its own append-only rule.

Recovery is a sweep at sidecar startup: `captures` rows with no corresponding event get their `CaptureIngested` re-emitted. It is idempotent by construction — `deriveEventId` hashes the `captureId` and not the payload, so re-emitting an event that did land is the no-op `EventStore.append` already guarantees (`ports/event-store.ts`). The sweep needs no bookkeeping of its own.

The sweep's query is an anti-join from `captures` to `events` on `capture_id`, filtered to `type = 'CaptureIngested'` — a Capture with *some* event but no ingestion event is still unrecovered, and an unfiltered anti-join would miss it once Slice 9 gives Captures a second event type. It **needs an index that does not exist**: Slice 0 created `events_by_aggregate` on `(aggregate_id, aggregate_version)` and nothing on `capture_id`. Add `events_by_capture` here. It is cheap at any realistic log size and the sweep is not the only thing that will want it — provenance lookups in Slice 6 walk the same column — but it is added now because this slice is the first to run the query.

**`ingested_at` is when the row was written**, distinct from `source_timestamp`, which is when the input arrived. Slice 0's schema has both and nothing said how they differ. Same ISO 8601 format; it is not in any hash, so a re-emitted sweep row keeps its original value.

That the payload is excluded from `eventId` matters twice over: it is what makes the sweep safe to run against a row whose normalised text would differ under a changed normaliser. Re-emission cannot fork the log. This was checked against `deriveEventId` rather than assumed — it follows from `identifyingParts`, which lists provenance, type, and aggregate, and nothing derived from the text.

**Duplicate handling matches the event store.** A second insert of an existing `capture_id` is a no-op that returns the stored Capture — not a throw, not a silent overwrite. `EventStore.append` already made this choice for events, and a storage port that throws where its sibling no-ops means every caller learns which is which. "Double-delivered input produces one Capture" is then a property of the store rather than a rule every call site remembers.

**The durability boundary.** The Capture is written before anything downstream runs, synchronous with the user's action, and a write failure surfaces to the user rather than failing silently.

## Not in scope

- **Extraction, and anything that reads the Capture's meaning.** Slice 3. Captures accumulate at the extraction stage, which is a state the system is designed to sit in.
- **Transcript correction.** Slice 9. The `corrected_text` column ships here and stays `NULL`; no correction affordance, no `CaptureTranscriptCorrected` event, and no re-extraction trigger.
- **Entity names as a transcription initial prompt** (`runtime.md` §2). It needs an entity projection to draw names from — Slice 6. Deferring it is safe; it is a proper-noun-recall mitigation, not a correctness requirement.
- **The dashboard.** Slice 11. The capture window is a tray affordance, not a window with navigation in it.
- **The full installer.** Slice 11 handles bundling per platform. This slice needs `whisper.cpp` running locally, not packaged for distribution.
- **The process model, the Rust host, the supervisor, and audio recording.** Slice 1. This slice adds storage and transcription to a runtime that already exists; if that runtime is not green, this slice cannot start.

## Build order

1. The `captures` reshaping in `CREATE_SCHEMA`, plus the `events_by_capture` index.
2. `CaptureStore` port and its SQLite adapter. One adapter, per `add.md` §9 — `:memory:` is the offline mode, and a second implementation of a storage port is what Slice 0 removed. This adds the repository-level half of `qa.md` §4.1's pair, which could not be written without the port.
3. Normalisation and the two id derivations, as pure functions with no I/O. They are the most specified thing in this slice and the easiest to test in isolation.
4. Ingestion, in this order: normalise, timestamp, derive `capture_id`, write the `captures` row, *then* build the Command and call the executor. The id is computed first because `deriveEventId` hashes `provenance.captureId` (`application/pipeline/event-identity.ts`) — the Command cannot be constructed until the id exists, and the row cannot be written after the event without inverting the recovery order above. This is easy to get backwards and produces a system that works until the first crash.
5. Typed capture from Slice 1's window through to a durable Capture, emitting `CaptureIngested` through Slice 0's executor. This is where `ingestTyped` replaces the window's discard.
6. The startup sweep that re-emits events for rows that have none.
7. `Transcriber` port and the `whisper-cli` adapter, at the far end of Slice 1's path handoff; `ingestVoice` replaces `readAudio`, and the host begins sending recording-start alongside the path. Voice capture runs through the same ingestion path as typed.
8. The eval corpus for transcription, then the latency and recall measurements.

**Step 7 is where the local-toolchain dependency bites.** Steps 1–6 need nothing a clean checkout does not have. Step 7's adapter is buildable and unit-testable with the spawn stubbed — the `Transcriber` port takes a path and returns text, which is mockable without a binary — but its integration test needs a real `whisper-cli` and a real `small.en`, so it is tagged out of the default run alongside the measurements below. Step 8 additionally needs the corpus, which is human work (see Verification).

## Verification

Tier 0 (`qa.md` §4.2, §4.3), plus the process-model test from §8:

- **A Capture is durably persisted before extraction is invoked.** Assert the ordering, not eventual presence — inject a failure at the extraction stage and confirm the Capture survives.
- **A crash between transcription and Capture persistence loses the audio, and this is the accepted behaviour.** The test documents the boundary rather than asserting recovery, and exists so that a future change moving work before the durability point does not pass silently. It is accepted only because both steps sit inside `ingestVoice`: the window is one handler wide and no process boundary crosses it. Splitting ingestion back into two calls would widen this window without widening the acceptance, which is the change this test is positioned to catch.
- Capture write failure surfaces to the user synchronously.
- **Double-delivered input produces one Capture** (§4.3). A retried voice upload yields the same `capture_id`, and the second insert returns the stored Capture rather than throwing. The retry must reuse the original recording-start timestamp, which is what makes this a test of the derivation rather than of the clock — assert it against a transcriber stubbed to take visibly different durations on the two runs, so an implementation that quietly timestamps at transcription-completion fails here rather than intermittently in production.
- **`ingestVoice` rejects a missing or malformed `sourceTimestamp`** rather than substituting its own clock. The whole of the previous bullet rests on the host supplying it, so the absence has to be loud.
- **A crash between the `captures` write and the event append is recovered by the startup sweep**, producing exactly one `CaptureIngested`. Run the sweep twice in the same test — the second pass must append nothing, which is what proves it rides on `deriveEventId` rather than on bookkeeping of its own.
- `captures` rejects UPDATE and DELETE at the SQLite level.
- **Normalisation is exactly the three stated rules.** Assert the transformations *and* their limits: punctuation, capitalisation, and filler words survive untouched. This is the test that fails when someone adds a fourth rule, which is the point of it.
- **Normalisation does not change `capture_id`.** Property-based: for arbitrary raw text, the id is stable across a changed normaliser. `fast-check` is already present from Slice 0.
- **The id derivations are pinned by golden values.** A fixed `(source, source_timestamp, raw_text)` triple and its expected `capture_id`, written as a literal in the test; likewise a fixed tuple and its expected `proposal_id`. Property-based tests confirm the derivations are *consistent*, which a wrong-but-consistent implementation also satisfies — only a literal catches a changed separator, a reordered field, or a different truncation. This is the test that makes the spec above enforceable rather than advisory.
- **`proposal_id` changes when the model version changes and not when it doesn't.** Both directions asserted, since a test of only the first passes on an implementation that hashed the model version away (`runtime.md` §3).
- **Capture round-trip stays responsive while the pipeline is saturated** (§8). With nothing yet running in the pipeline this is a weak test; it is written here and gains its teeth in Slice 3, when a long local extraction is available to saturate with. It guards the entire process-model decision.
- Transcription: proper-noun recall rather than general WER (§6.4), and latency ≤ 2× realtime. Both need a corpus that does not exist, so this slice builds it — see below.

**The transcription corpus.** `qa.md` §6.4 asks for proper-noun recall, which needs labelled audio; nothing upstream creates it, so it is part of this slice's work rather than an assumed input.

Thirty to fifty recordings, self-recorded, each a plausible Otto capture of five to twenty seconds, stored in `tests/fixtures/audio/` with a sibling JSON transcript per clip listing the expected proper nouns. It is deliberately small and deliberately hand-made: this measures whether `small.en` keeps names intact, not general accuracy, so coverage of hard names beats volume. Include names that are common-word homophones, names with non-English spellings, and initialisms — that is where a small model fails.

The metric is the fraction of expected proper nouns appearing exactly in the transcript. There is no pass threshold in this slice, because there is no mitigation to compare against: the initial-prompt mitigation needs an entity projection and arrives in Slice 6, and transcript correction arrives in Slice 9. This slice's job is to produce the number those slices are measured against. It is checked in and versioned, so that a `whisper.cpp` or model change is a visible diff in recall rather than a silent regression.

**Recording the clips is human work and blocks nothing else.** It cannot be delegated to an implementer, and it is the only item here that can't be. Build-order steps 1–7 are unblocked without it; step 8 is where it is needed. Write the harness against an empty fixture directory first — it should report "0 clips" rather than fail — so the corpus arriving is a data change rather than a code change.

**The latency baseline.** Recorded as a JSON file in `tests/baselines/capture-latency.json`, checked in, holding the median and p95 of hotkey-to-durable-Capture over a fixed run count, plus the machine and OS it was taken on. "Must not regress" needs something to compare against and somewhere to notice the comparison, and a number in a commit message is neither.

Later slices assert against the committed file rather than re-deriving it. It is expected to be re-taken when hardware changes — the file records the machine so a cross-machine comparison is visibly meaningless rather than quietly wrong.

**Neither measurement runs in CI.** The recall test needs a local `whisper.cpp` build and its model; the latency test needs a known machine class, and a shared runner's timing is noise. Both are tagged out of the default `npm test` and run on demand — otherwise CI goes red the moment the transcriber lands, and the usual fix for a red CI is deleting the test.

This is the first split in the test suite, so it is worth stating what governs it: a test leaves the default run only when it depends on something a clean checkout does not have. Everything in `qa.md` §4 stays in, since Tier 0 is what a commit must not break.

## Done when

- Hotkey to durable Capture works for both typed and voice input, with the tray closed and the dashboard not built.
- Killing the sidecar mid-run leaves the Capture intact and the supervisor restarts it.
- The same input delivered twice produces one Capture, including a re-uploaded recording of identical audio.
- A crash between the two writes leaves a recoverable Capture, and the sweep is idempotent.
- Both id derivations are pinned by golden-value tests, so a changed separator or field order fails the build.
- The measurement tests are tagged out of the default run and CI is green without them.
- The transcription corpus is checked in, and its proper-noun recall on `small.en` is recorded.
- Capture latency is measured and committed to `tests/baselines/capture-latency.json` as the baseline the later slices must not regress.
