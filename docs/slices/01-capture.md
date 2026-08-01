# Slice 1 — Capture

> Depends on: Slice 0. Blocks: Slice 2.
> Sources: [`prd.md`](../prd.md) §5.1; [`add.md`](../add.md) §4, §5.1, §9, §11; [`runtime.md`](../runtime.md) §1, §2, §3, §5; [`qa.md`](../qa.md) §4.1, §4.2, §4.3, §6.4, §8; [`stack.md`](../stack.md) §8; ADR-0013.

## What it closes

The user presses a hotkey, speaks or types a thought, and it is durably stored as an immutable Capture. Nothing reads it yet — but the words are safe, which `add.md` §11 identifies as the one thing Otto can genuinely lose.

This is the first slice with a user in it, and the first with all three processes running.

## Why here

Capture is the only stage with no inference in it, which makes it the only one that can be built and verified before any model exists. It is also where PRD §4.1's first principle lives: if capture costs more than a few seconds the user will not do it consistently and everything downstream is worthless. Building it first means the latency budget is a constraint the rest of the system is built under rather than one it is measured against at the end.

The process model has to be settled here too, because capture is what forces three processes: audio and the tray are Rust, the pipeline is TypeScript, and the UI is a WebView (`runtime.md` §1).

## In scope

**The three-process runtime.** Tauri host (Rust), Node sidecar, Svelte WebView, per `runtime.md` §1. JSON-RPC over stdio — no local HTTP port, because there is nothing to conflict with, firewall, or accidentally expose. SQLite opened by both processes in WAL mode.

**The sidecar supervisor**, restarting on exit with backoff. Because the pipeline is resumable per stage, a restart resumes rather than replays; a crash loop degrades to "captures accumulate," which `add.md` §11 already treats as a handled state.

**Tray, global hotkey, and the capture window.** Available without opening the full dashboard (PRD §5.1). One note per thought — no title, no category, no tags.

**Typed capture.** The simpler of the two paths and the one that proves the durability boundary without a model in the way.

**Voice capture and transcription.** `whisper.cpp` with `small.en`, bundled, via the `Transcriber` port (`runtime.md` §2). The one port where local is non-negotiable — a capture path requiring a network is not a local-first system. Budget: ≤ 2× realtime on an 8-core consumer machine.

**Transcription runs in the Node sidecar, not the Rust host.** Audio capture is Rust because that is where the OS APIs are; transcription is not, because `add.md` §9 puts it behind a port and `ports/` is a TypeScript directory. Putting the adapter in Rust would place a port implementation in a language with no ports directory and no lint rule watching it, which is how the boundary Slice 0 enforces gets quietly holed. The Rust host records audio to a temporary file and passes the *path* over JSON-RPC; the sidecar reads it, invokes `whisper.cpp` through the adapter, and deletes it. Audio bytes therefore never cross stdio — a path is small and a WAV is not.

The cost is honest: two processes touch one temporary file, so its lifetime needs owning. The host writes it and the sidecar deletes it after a successful read; a sidecar crash leaves an orphan, which the supervisor sweeps on restart. That is a smaller problem than a port living outside the architecture.

**The `CaptureStore` port** and its SQLite adapter, separate from the `EventStore` because Captures are input, not change (`add.md` §9). One adapter — `:memory:` is the offline mode for a storage port.

**The `captures` table, reshaped.** Slice 0 already created it with its insert-only triggers, and this slice changes its shape: Slice 0's single `text` column becomes `raw_text`, and a nullable `corrected_text` is added. The repository-level half of `qa.md` §4.1's pair lands here too, since it could not be written without the port.

A third column, `transcription_model`, records what produced a voice Capture's text — `NULL` for a typed one. It sits here rather than in Provenance for the reason given below: it describes the input, not an inference whose thresholds need calibrating.

**Reshaping it is a migration, and this slice does it by editing `CREATE_SCHEMA` in place.** That is worth stating plainly rather than calling the change additive, because it isn't. There is no migration mechanism in the repository and this slice does not build one: `CREATE_SCHEMA` uses `CREATE TABLE IF NOT EXISTS`, so a developer's existing database would silently keep the old shape and fail at the first insert against a column that isn't there. Any pre-Slice-1 database is disposable — nothing has shipped, no Capture in one is worth keeping — so the migration procedure is "delete the file." A real migration mechanism arrives when there is a real user's database to protect, which is Slice 10 at the earliest.

The distinction that *does* hold is the one about Slice 8. `corrected_text` stays `NULL` for the whole of this slice and is the field Slice 8 writes, which is what makes that slice an append rather than a second reshaping (`runtime.md` §5). Declaring the column now costs one nullable column while the database is still disposable; discovering it in Slice 8 costs a migration at the point where one might actually be needed.

Normalised text is not stored. It is derived from `raw_text` by a pure function, and a stored copy would be a second truth that can disagree with the first. `CaptureIngested`'s existing `text` field carries the normalised form for downstream consumers, and its payload gains no correction field — the corrected text arrives on `CaptureTranscriptCorrected` in Slice 8, per `add.md` §5.1, and duplicating it onto the ingestion event would mean two events claiming the same fact.

**Idempotency, keyed on the Capture.** `capture_id = hash(source, source_timestamp, content_hash)` (`runtime.md` §3), made concrete:

- **The hash is SHA-256, truncated to 32 hex characters, prefixed `cap-`.** This matches `deriveEventId` in `application/pipeline/event-identity.ts`, which Slice 0 settled. Two id schemes in one system is a coin-flip every time someone writes a third.
- **`content_hash` is over the raw text, not the normalised text.** Normalisation is a pure function of the raw text, so hashing the raw form is strictly more discriminating, and it keeps the key stable if the normaliser is ever changed — hashing normalised text would silently re-key every existing Capture the day whitespace handling is touched.
- **`source_timestamp` for a voice Capture is when recording *started*.** Recording end and transcription-completion are both wrong, and wrong in a way that breaks the retried-upload test in Verification: transcription is non-deterministic in duration, so a re-upload of identical audio would produce a different timestamp and therefore a different `capture_id` — a duplicate Capture from the same input, which is exactly what §4.3 forbids. Recording start is a property of the input; the other two are properties of the run.
- **`source_timestamp` is ISO 8601 with millisecond precision, UTC.** Fixed precision matters: the same instant formatted two ways hashes two ways.

The `proposal_id` derivation that includes provider and model version is specified here and used in Slice 2 — it is written down now because getting it wrong is what `runtime.md` §3 exists to prevent, and the two halves pull in opposite directions.

**Provenance on `CaptureIngested`, where no inference happened.** The executor requires a `Provenance` with a non-empty `provider` and `modelVersion` (`domain/values/provenance.ts`), and ingestion has no model to name. Both capture paths use `humanConfirmedProvenance` — `provider` and `modelVersion` both `"human"`, `confidence: null`, `isHumanConfirmed: true`, `proposalId: null`.

**Voice does not record `whisper.cpp` as the provider**, which is the tempting answer and the wrong one. `provider` and `modelVersion` are the key `triage.md` §2 uses for thresholds and §4 uses to count Corrections toward bootstrap exit. A transcriber never proposes anything and has no Confidence to calibrate, so a `whisper.cpp` cohort would be a bootstrap bucket that can never fill and a threshold row that is never read. The field means *the inference provider whose judgement this record is calibrating*, and transcription is not a judgement about knowledge — it is how the user's words arrived.

`isHumanConfirmed: true` is right for the same reason. It does not assert the transcript is accurate; it asserts nothing unattended decided anything. The user typed or said this, and no inference stands between them and the Capture. A misheard name is a wrong Capture, not an unconfirmed one — which is exactly why correction is its own event in Slice 8 rather than a Confidence here.

What model transcribed a Capture is still worth knowing, and it belongs on the Capture rather than in Provenance. The `captures` row records the transcription model alongside `source`, where it describes the input rather than an inference. Nothing in the MVP reads it — Slice 8 excludes re-transcription — so it is recorded because it cannot be reconstructed afterwards, the same reasoning ADR-0006 applies to provenance generally. A `large-v3` upgrade someday needs to know which Captures came from `small.en`, and by then the answer is unrecoverable if it was never written down.

**Slice 0's test fixtures contradict this and are corrected here.** `tests/support/builders.ts` builds a Capture's Provenance with `provider: "local"`, `modelVersion: "qwen2.5-7b-instruct"`, `confidence: 0.92`, and `proposalId: "prop-1"` — an extraction's provenance attached to an ingestion event. It is well-formed, so nothing failed; it was a placeholder written when `CaptureIngested` existed only to prove the write path had two ends. Adopting it by imitation is the likely failure mode, since it is the only worked example in the repository. `aProvenance` stays as it is for the inference slices that will need it, and the Capture builders switch to `humanConfirmedProvenance`.

Two smaller corrections in the same area, both cheap now and awkward later:

- **`CaptureIngestedPayload.contentHash`'s doc comment describes it as `hash(source, sourceTimestamp, contentHash)`** (`domain/events/capture-ingested.ts`), which defines the field in terms of itself. It is an *input* to `capture_id`, not the key. The comment is wrong rather than the field.
- **The fixture's `"sha256:abc123"` is not a value this slice's derivation can produce.** Hashes are bare 32-hex-character strings with no algorithm prefix; `capture_id` carries the `cap-` prefix, `content_hash` carries none. Fixtures that cannot occur in production are how an assumption about format survives until something parses it.

**Ingestion, and its hard rule.** Transcription, whitespace and transcript cleanup, timestamping, deduplication — and nothing semantic. `add.md` §5.1 uses date-noticing as the specific example of what ingestion must not do. The temptation is constant and moving it earlier turns a normaliser into a second, undisciplined extractor.

**Normalisation, exhaustively.** "Whitespace and transcript cleanup" needs a closed list, because a normaliser with an open brief is the second extractor `add.md` §5.1 warns about. It does exactly three things: trim leading and trailing whitespace, collapse internal runs of whitespace to a single space, and normalise Unicode to NFC. Nothing else — no punctuation repair, no capitalisation, no filler-word removal, all of which require deciding what the user meant.

It is a pure function in `capture/`, and it does not feed `content_hash`, which covers raw text. That combination is what makes the list safe to extend later: adding a rule changes what downstream reads without re-keying a single existing Capture.

**The Capture is its own aggregate, and `capture_id` is the aggregate id.** `CaptureIngested` is always version 0 of a new aggregate, so `expectedVersion` is 0 for every ingestion and `#rejectIfStale` can only fire if the same Capture is ingested twice concurrently — which the single-threaded pipeline (`add.md` §4) already prevents. That is worth noting rather than discovering: the staleness machinery is inert in this slice by construction, not by luck, and Slice 8's `CaptureTranscriptCorrected` is what gives the Capture aggregate a version 1 and makes the check live.

**Ordering: the Capture row is written before the event.** Two separate ports with no shared transaction (`add.md` §9), so one of the two orders has to be chosen and the crash between them accounted for.

The row goes first. A `captures` row with no `CaptureIngested` event is a Capture the log does not mention — invisible to the pipeline, and recoverable, because the row holds everything the event's payload needs and re-running ingestion for it produces the identical `capture_id` and therefore the identical `eventId`. The reverse order fails worse: an event pointing at a row that does not exist is a dangling reference in the one table that is truth, and the log cannot be repaired without violating its own append-only rule.

Recovery is a sweep at sidecar startup: `captures` rows with no corresponding event get their `CaptureIngested` re-emitted. It is idempotent by construction — `deriveEventId` hashes the `captureId` and not the payload, so re-emitting an event that did land is the no-op `EventStore.append` already guarantees (`ports/event-store.ts`). The sweep needs no bookkeeping of its own.

That the payload is excluded from `eventId` matters twice over: it is what makes the sweep safe to run against a row whose normalised text would differ under a changed normaliser. Re-emission cannot fork the log. This was checked against `deriveEventId` rather than assumed — it follows from `identifyingParts`, which lists provenance, type, and aggregate, and nothing derived from the text.

**Duplicate handling matches the event store.** A second insert of an existing `capture_id` is a no-op that returns the stored Capture — not a throw, not a silent overwrite. `EventStore.append` already made this choice for events, and a storage port that throws where its sibling no-ops means every caller learns which is which. "Double-delivered input produces one Capture" is then a property of the store rather than a rule every call site remembers.

**The durability boundary.** The Capture is written before anything downstream runs, synchronous with the user's action, and a write failure surfaces to the user rather than failing silently.

## Not in scope

- **Extraction, and anything that reads the Capture's meaning.** Slice 2. Captures accumulate at the extraction stage, which is a state the system is designed to sit in.
- **Transcript correction.** Slice 8. The `corrected_text` column ships here and stays `NULL`; no correction affordance, no `CaptureTranscriptCorrected` event, and no re-extraction trigger.
- **Entity names as a transcription initial prompt** (`runtime.md` §2). It needs an entity projection to draw names from — Slice 5. Deferring it is safe; it is a proper-noun-recall mitigation, not a correctness requirement.
- **The dashboard.** Slice 10. The capture window is a tray affordance, not a window with navigation in it.
- **The full installer.** Slice 10 handles bundling per platform. This slice needs `whisper.cpp` running locally, not packaged for distribution.

## The Rust half

This slice introduces Rust to a repository that has none — there is no `src-tauri/` and no toolchain in `package.json`. It is the largest single piece of work here and the least visible in a build-order list, so it is budgeted separately.

**What lands:** `src-tauri/` with its own `Cargo.toml`, a Tauri host owning the tray, the global hotkey, the capture window, audio recording to a temporary file, the sidecar's lifecycle, and the JSON-RPC client half of the stdio transport. Nothing else. The host is a shell around OS APIs — no domain types, no persistence, no knowledge of what a Capture means. `add.md` §3's layer rules govern `src/`; the host stays thin enough that they never need to reach it.

**What this slice decides, closing two `stack.md` §8 rows partially:** the Rust toolchain version, pinned in `rust-toolchain.toml`; the Tauri major version; the audio-capture crate; and how the sidecar is spawned — which is where the Node-shipping question bites, because the host must find a Node runtime to launch. This slice takes the *development* answer only: the host spawns the developer's installed Node. Shipping a Node runtime inside the installer stays with packaging in Slice 10, and the spawn path is written with a configurable interpreter location so that slice substitutes a bundled binary rather than rewriting the supervisor.

**How the sidecar invokes `whisper.cpp`: by shelling out to the `whisper-cli` binary**, not through a Node native binding. The adapter spawns a process, passes the audio path and the model path, and reads the transcript from its output. A native binding buys in-process speed that a port taking a file path cannot use anyway, and costs a compiled dependency that must be rebuilt per Node version and per platform — on top of `better-sqlite3`, which is already one. Shelling out also keeps the adapter honest: everything it needs is behind the `Transcriber` signature, and swapping the binary for `large-v3` is a path change (`runtime.md` §2).

**What it explicitly does not decide:** the installer, code signing, notarisation, or per-platform bundling of `whisper.cpp` and its model. Slice 10. Development here runs `cargo tauri dev` against a locally present `whisper.cpp` build.

**Where the risk is:** the toolchain, not the code. Two build systems in one repo, a CI runner that now needs Rust, and a `whisper.cpp` binding that is a native dependency behind a native dependency. Budget the setup, not the logic.

## Build order

1. `src-tauri/` skeleton, toolchain pin, and CI extended to build it. Nothing functional — just both build systems green on one commit, because discovering a broken Rust CI once the transcriber lands is expensive.
2. Tauri host, Node sidecar, and the JSON-RPC-over-stdio transport between them. Prove a round trip.
3. Supervisor with backoff restart, the crash-loop degradation path, and the orphaned-audio-file sweep.
4. `CaptureStore` port and its SQLite adapter. One adapter, per `add.md` §9 — `:memory:` is the offline mode, and a second implementation of a storage port is what Slice 0 removed. The `captures` table and its insert-only triggers already exist from Slice 0; this adds `raw_text`/`corrected_text` and the repository-level half of `qa.md` §4.1's pair, which could not be written without the port.
5. Ingestion, in this order: normalise, timestamp, derive `capture_id`, write the `captures` row, *then* build the Command and call the executor. The id is computed first because `deriveEventId` hashes `provenance.captureId` (`application/pipeline/event-identity.ts`) — the Command cannot be constructed until the id exists, and the row cannot be written after the event without inverting the recovery order above. This is easy to get backwards and produces a system that works until the first crash.
6. Typed capture through the tray to a durable Capture, emitting `CaptureIngested` through Slice 0's executor.
7. The startup sweep that re-emits events for rows that have none.
8. Audio recording in the host, and the path handoff to the sidecar.
9. `Transcriber` port and the `whisper.cpp` adapter; voice capture through the same path.
10. The eval corpus for transcription, then the latency and recall measurements.

## Verification

Tier 0 (`qa.md` §4.2, §4.3), plus the process-model test from §8:

- **A Capture is durably persisted before extraction is invoked.** Assert the ordering, not eventual presence — inject a failure at the extraction stage and confirm the Capture survives.
- **A crash between transcription and Capture persistence loses the audio, and this is the accepted behaviour.** The test documents the boundary rather than asserting recovery, and exists so that a future change moving work before the durability point does not pass silently.
- Capture write failure surfaces to the user synchronously.
- **Double-delivered input produces one Capture** (§4.3). A retried voice upload yields the same `capture_id`, and the second insert returns the stored Capture rather than throwing.
- **A crash between the `captures` write and the event append is recovered by the startup sweep**, producing exactly one `CaptureIngested`. Run the sweep twice in the same test — the second pass must append nothing, which is what proves it rides on `deriveEventId` rather than on bookkeeping of its own.
- `captures` rejects UPDATE and DELETE at the SQLite level.
- **Normalisation is exactly the three stated rules.** Assert the transformations *and* their limits: punctuation, capitalisation, and filler words survive untouched. This is the test that fails when someone adds a fourth rule, which is the point of it.
- **Normalisation does not change `capture_id`.** Property-based: for arbitrary raw text, the id is stable across a changed normaliser. `fast-check` is already present from Slice 0.
- **Capture round-trip stays responsive while the pipeline is saturated** (§8). With nothing yet running in the pipeline this is a weak test; it is written here and gains its teeth in Slice 2, when a long local extraction is available to saturate with. It guards the entire process-model decision.
- Transcription: proper-noun recall rather than general WER (§6.4), and latency ≤ 2× realtime. Both need a corpus that does not exist, so this slice builds it — see below.

**The transcription corpus.** `qa.md` §6.4 asks for proper-noun recall, which needs labelled audio; nothing upstream creates it, so it is part of this slice's work rather than an assumed input.

Thirty to fifty recordings, self-recorded, each a plausible Otto capture of five to twenty seconds, stored in `tests/fixtures/audio/` with a sibling JSON transcript per clip listing the expected proper nouns. It is deliberately small and deliberately hand-made: this measures whether `small.en` keeps names intact, not general accuracy, so coverage of hard names beats volume. Include names that are common-word homophones, names with non-English spellings, and initialisms — that is where a small model fails.

The metric is the fraction of expected proper nouns appearing exactly in the transcript. There is no pass threshold in this slice, because there is no mitigation to compare against: the initial-prompt mitigation needs an entity projection and arrives in Slice 5, and transcript correction arrives in Slice 8. This slice's job is to produce the number those slices are measured against. It is checked in and versioned, so that a `whisper.cpp` or model change is a visible diff in recall rather than a silent regression.

**Recording the clips is human work and blocks nothing else.** It cannot be delegated to an implementer, and it is the only item here that can't be. Build-order steps 1–9 are unblocked without it; step 10 is where it is needed. Write the harness against an empty fixture directory first — it should report "0 clips" rather than fail — so the corpus arriving is a data change rather than a code change.

**The latency baseline.** Recorded as a JSON file in `tests/baselines/capture-latency.json`, checked in, holding the median and p95 of hotkey-to-durable-Capture over a fixed run count, plus the machine and OS it was taken on. "Must not regress" needs something to compare against and somewhere to notice the comparison, and a number in a commit message is neither.

Later slices assert against the committed file rather than re-deriving it. It is expected to be re-taken when hardware changes — the file records the machine so a cross-machine comparison is visibly meaningless rather than quietly wrong.

**Neither measurement runs in CI.** The recall test needs a local `whisper.cpp` build and its model; the latency test needs a known machine class, and a shared runner's timing is noise. Both are tagged out of the default `npm test` and run on demand — otherwise CI goes red the moment the transcriber lands, and the usual fix for a red CI is deleting the test.

This is the first split in the test suite, so it is worth stating what governs it: a test leaves the default run only when it depends on something a clean checkout does not have. Everything in `qa.md` §4 stays in, since Tier 0 is what a commit must not break.

## Done when

- Hotkey to durable Capture works for both typed and voice input, with the tray closed and the dashboard not built.
- Killing the sidecar mid-run leaves the Capture intact and the supervisor restarts it.
- The same input delivered twice produces one Capture, including a re-uploaded recording of identical audio.
- A crash between the two writes leaves a recoverable Capture, and the sweep is idempotent.
- `cargo` and `npm` both build in CI on one commit, with the measurement tests tagged out of the default run.
- The transcription corpus is checked in, and its proper-noun recall on `small.en` is recorded.
- Capture latency is measured and committed to `tests/baselines/capture-latency.json` as the baseline the later slices must not regress.
