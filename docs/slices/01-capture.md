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

**The `captures` table, extended.** Slice 0 already created it with its insert-only triggers, so this slice does not introduce it — it adds the two columns Slice 0 had no use for and the repository-level half of `qa.md` §4.1's pair.

The columns are `raw_text` and a nullable `corrected_text`. Slice 0's single `text` column becomes `raw_text`: what the transcriber produced, or what the user typed, before normalisation. `corrected_text` stays `NULL` for the whole of this slice and is the field Slice 8 writes, which is what makes that slice an append rather than a migration (`runtime.md` §5). Declaring it now costs one nullable column; discovering it in Slice 8 costs a migration against a table whose triggers refuse UPDATE.

Normalised text is not stored. It is derived from `raw_text` by a pure function, and a stored copy would be a second truth that can disagree with the first. `CaptureIngested`'s existing `text` field carries the normalised form for downstream consumers, and its payload gains no correction field — the corrected text arrives on `CaptureTranscriptCorrected` in Slice 8, per `add.md` §5.1, and duplicating it onto the ingestion event would mean two events claiming the same fact.

**Idempotency, keyed on the Capture.** `capture_id = hash(source, source_timestamp, content_hash)` (`runtime.md` §3), made concrete:

- **The hash is SHA-256, truncated to 32 hex characters, prefixed `cap-`.** This matches `deriveEventId` in `application/pipeline/event-identity.ts`, which Slice 0 settled. Two id schemes in one system is a coin-flip every time someone writes a third.
- **`content_hash` is over the raw text, not the normalised text.** Normalisation is a pure function of the raw text, so hashing the raw form is strictly more discriminating, and it keeps the key stable if the normaliser is ever changed — hashing normalised text would silently re-key every existing Capture the day whitespace handling is touched.
- **`source_timestamp` for a voice Capture is when recording *started*.** Recording end and transcription-completion are both wrong, and wrong in a way that breaks the retried-upload test in Verification: transcription is non-deterministic in duration, so a re-upload of identical audio would produce a different timestamp and therefore a different `capture_id` — a duplicate Capture from the same input, which is exactly what §4.3 forbids. Recording start is a property of the input; the other two are properties of the run.
- **`source_timestamp` is ISO 8601 with millisecond precision, UTC.** Fixed precision matters: the same instant formatted two ways hashes two ways.

The `proposal_id` derivation that includes provider and model version is specified here and used in Slice 2 — it is written down now because getting it wrong is what `runtime.md` §3 exists to prevent, and the two halves pull in opposite directions.

**Ingestion, and its hard rule.** Transcription, whitespace and transcript cleanup, timestamping, deduplication — and nothing semantic. `add.md` §5.1 uses date-noticing as the specific example of what ingestion must not do. The temptation is constant and moving it earlier turns a normaliser into a second, undisciplined extractor.

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

**What it explicitly does not decide:** the installer, code signing, notarisation, or per-platform bundling of `whisper.cpp` and its model. Slice 10. Development here runs `cargo tauri dev` against a locally present `whisper.cpp` build.

**Where the risk is:** the toolchain, not the code. Two build systems in one repo, a CI runner that now needs Rust, and a `whisper.cpp` binding that is a native dependency behind a native dependency. Budget the setup, not the logic.

## Build order

1. `src-tauri/` skeleton, toolchain pin, and CI extended to build it. Nothing functional — just both build systems green on one commit, because discovering a broken Rust CI at step 8 is expensive.
2. Tauri host, Node sidecar, and the JSON-RPC-over-stdio transport between them. Prove a round trip.
3. Supervisor with backoff restart, the crash-loop degradation path, and the orphaned-audio-file sweep.
4. `CaptureStore` port and its SQLite adapter. One adapter, per `add.md` §9 — `:memory:` is the offline mode, and a second implementation of a storage port is what Slice 0 removed. The `captures` table and its insert-only triggers already exist from Slice 0; this adds `raw_text`/`corrected_text` and the repository-level half of `qa.md` §4.1's pair, which could not be written without the port.
5. Ingestion: normalisation, timestamping, and the `capture_id` derivation.
6. Typed capture through the tray to a durable Capture, emitting `CaptureIngested` through Slice 0's executor.
7. Audio recording in the host, and the path handoff to the sidecar.
8. `Transcriber` port and the `whisper.cpp` adapter; voice capture through the same path.
9. The eval corpus for transcription, then the latency and recall measurements.

## Verification

Tier 0 (`qa.md` §4.2, §4.3), plus the process-model test from §8:

- **A Capture is durably persisted before extraction is invoked.** Assert the ordering, not eventual presence — inject a failure at the extraction stage and confirm the Capture survives.
- **A crash between transcription and Capture persistence loses the audio, and this is the accepted behaviour.** The test documents the boundary rather than asserting recovery, and exists so that a future change moving work before the durability point does not pass silently.
- Capture write failure surfaces to the user synchronously.
- **Double-delivered input produces one Capture** (§4.3). A retried voice upload yields the same `capture_id`.
- `captures` rejects UPDATE and DELETE at the SQLite level.
- **Capture round-trip stays responsive while the pipeline is saturated** (§8). With nothing yet running in the pipeline this is a weak test; it is written here and gains its teeth in Slice 2, when a long local extraction is available to saturate with. It guards the entire process-model decision.
- Transcription: proper-noun recall rather than general WER (§6.4), and latency ≤ 2× realtime. Both need a corpus that does not exist, so this slice builds it — see below.

**The transcription corpus.** `qa.md` §6.4 asks for proper-noun recall, which needs labelled audio; nothing upstream creates it, so it is part of this slice's work rather than an assumed input.

Thirty to fifty recordings, self-recorded, each a plausible Otto capture of five to twenty seconds, stored in `tests/fixtures/audio/` with a sibling JSON transcript per clip listing the expected proper nouns. It is deliberately small and deliberately hand-made: this measures whether `small.en` keeps names intact, not general accuracy, so coverage of hard names beats volume. Include names that are common-word homophones, names with non-English spellings, and initialisms — that is where a small model fails.

The metric is the fraction of expected proper nouns appearing exactly in the transcript. There is no pass threshold in this slice, because there is no mitigation to compare against: the initial-prompt mitigation needs an entity projection and arrives in Slice 5, and transcript correction arrives in Slice 8. This slice's job is to produce the number those slices are measured against. It is checked in and versioned, so that a `whisper.cpp` or model change is a visible diff in recall rather than a silent regression.

**The latency baseline.** Recorded as a JSON file in `tests/baselines/capture-latency.json`, checked in, holding the median and p95 of hotkey-to-durable-Capture over a fixed run count, plus the machine and OS it was taken on. "Must not regress" needs something to compare against and somewhere to notice the comparison, and a number in a commit message is neither.

Later slices assert against the committed file rather than re-deriving it. It is expected to be re-taken when hardware changes — the file records the machine so a cross-machine comparison is visibly meaningless rather than quietly wrong.

## Done when

- Hotkey to durable Capture works for both typed and voice input, with the tray closed and the dashboard not built.
- Killing the sidecar mid-run leaves the Capture intact and the supervisor restarts it.
- The same input delivered twice produces one Capture, including a re-uploaded recording of identical audio.
- `cargo` and `npm` both build in CI on one commit.
- The transcription corpus is checked in, and its proper-noun recall on `small.en` is recorded.
- Capture latency is measured and committed to `tests/baselines/capture-latency.json` as the baseline the later slices must not regress.
