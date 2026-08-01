# Slice 1 — Capture

> Depends on: Slice 0. Blocks: Slice 2.
> Sources: [`prd.md`](../prd.md) §5.1; [`add.md`](../add.md) §4, §5.1, §11; [`runtime.md`](../runtime.md) §1, §2, §3; [`qa.md`](../qa.md) §4.2, §4.3; ADR-0013.

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

**The `CaptureStore` port** and its two adapters, separate from the `EventStore` because Captures are input, not change (`add.md` §9).

**The `captures` table** — immutable, one row per thing the user put in, with source, raw text, timestamp, and idempotency key (`add.md` §10). Insert-only at both the application and SQLite levels, the same double enforcement Slice 0 built for `events`.

**Idempotency, keyed on the Capture.** `capture_id = hash(source, source_timestamp, content_hash)` (`runtime.md` §3). The `proposal_id` derivation that includes provider and model version is specified here and used in Slice 2 — it is written down now because getting it wrong is what `runtime.md` §3 exists to prevent, and the two halves pull in opposite directions.

**Ingestion, and its hard rule.** Transcription, whitespace and transcript cleanup, timestamping, deduplication — and nothing semantic. `add.md` §5.1 uses date-noticing as the specific example of what ingestion must not do. The temptation is constant and moving it earlier turns a normaliser into a second, undisciplined extractor.

**The durability boundary.** The Capture is written before anything downstream runs, synchronous with the user's action, and a write failure surfaces to the user rather than failing silently.

## Not in scope

- **Extraction, and anything that reads the Capture's meaning.** Slice 2. Captures accumulate at the extraction stage, which is a state the system is designed to sit in.
- **Transcript correction.** Slice 8. The Capture's shape here must already allow for an optional corrected text so that slice appends rather than migrates, but no correction affordance ships.
- **Entity names as a transcription initial prompt** (`runtime.md` §2). It needs an entity projection to draw names from — Slice 5. Deferring it is safe; it is a proper-noun-recall mitigation, not a correctness requirement.
- **The dashboard.** Slice 10. The capture window is a tray affordance, not a window with navigation in it.
- **The full installer.** Slice 10 handles bundling per platform. This slice needs `whisper.cpp` running locally, not packaged for distribution.

## Build order

1. Tauri host, Node sidecar, and the JSON-RPC-over-stdio transport between them. Prove a round trip.
2. Supervisor with backoff restart, and the crash-loop degradation path.
3. `CaptureStore` port, in-memory and SQLite adapters, `captures` table with insert-only enforcement.
4. Ingestion: normalisation, timestamping, and the `capture_id` derivation.
5. Typed capture through the tray to a durable Capture, emitting `CaptureIngested` through Slice 0's executor.
6. `Transcriber` port and the `whisper.cpp` adapter; voice capture through the same path.
7. The latency measurement, against `runtime.md` §2's ≤ 2× realtime budget.

## Verification

Tier 0 (`qa.md` §4.2, §4.3), plus the process-model test from §8:

- **A Capture is durably persisted before extraction is invoked.** Assert the ordering, not eventual presence — inject a failure at the extraction stage and confirm the Capture survives.
- **A crash between transcription and Capture persistence loses the audio, and this is the accepted behaviour.** The test documents the boundary rather than asserting recovery, and exists so that a future change moving work before the durability point does not pass silently.
- Capture write failure surfaces to the user synchronously.
- **Double-delivered input produces one Capture** (§4.3). A retried voice upload yields the same `capture_id`.
- `captures` rejects UPDATE and DELETE at the SQLite level.
- **Capture round-trip stays responsive while the pipeline is saturated** (§8). With nothing yet running in the pipeline this is a weak test; it is written here and gains its teeth in Slice 2, when a long local extraction is available to saturate with. It guards the entire process-model decision.
- Transcription: proper-noun recall rather than general WER (§6.4), and latency ≤ 2× realtime.

## Done when

- Hotkey to durable Capture works for both typed and voice input, with the tray closed and the dashboard not built.
- Killing the sidecar mid-run leaves the Capture intact and the supervisor restarts it.
- The same input delivered twice produces one Capture.
- Capture latency is measured and recorded as the baseline the later slices must not regress.
