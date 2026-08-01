# Voice ingestion is one sidecar call, and the host supplies recording-start time

---
Status: accepted
---

ADR-0013 put the pipeline in a Node sidecar and the transport on stdio JSON-RPC. ADR-0017 settled how the sidecar is spawned and where its TypeScript lives. Neither says what the sidecar's *voice* method looks like, and Slice 1 shipped a placeholder — `readAudio`, which read the host's temporary WAV, reported its size, and deleted it — explicitly to prove the path handoff before a transcriber existed.

Slice 2 puts a transcriber at the far end of that handoff, which forces the question the placeholder deferred: does the host call one method that transcribes and ingests, or two that do them separately? This is an interface decision in the sense AGENTS.md means — a published contract between two processes — and it is load-bearing for a durability guarantee rather than a matter of ergonomics.

**Voice ingestion is a single call.** The sidecar exposes `ingestVoice`, which transcribes the recording, persists the Capture, and then deletes the temporary file. `ingestTyped` is its sibling for the typed path. Both return the resulting Capture, and both run through one internal ingestion function so the write ordering `runtime.md` §3 specifies is implemented once.

The reason is the crash window. `qa.md` §4.2 accepts that a crash between transcription and Capture persistence loses the audio — the recording is gone, the words were never durable, and there is nothing to recover. That acceptance is bounded by the window being one handler wide. Two calls would put a process boundary and a round trip inside it, and make the host responsible for closing a gap it structurally cannot close: the host has no database access (`runtime.md` §1 keeps SQLite in the sidecar until Slice 6 at the earliest), so a host holding a transcript with a failed ingest call has nowhere durable to put it. One call keeps the accepted window the only window.

**The host sends recording-start time with the path.** `runtime.md` §3 requires `source_timestamp` for a voice Capture to be when recording *started*, because recording-end and transcription-completion are properties of the run rather than the input — either would give a re-upload of identical audio a different `capture_id` and produce the duplicate Capture that section exists to prevent. Recording start is knowable only in the host, at the moment it opens the input device. Slice 1's transport carried a path and nothing else, so the field is added to the call.

It is **required, not defaulted**. A sidecar that falls back to its own clock produces transcription-completion time under recording-start's name, and the resulting bug is timing-dependent: the retried-upload test passes when transcription is fast enough that both runs round to the same millisecond, and fails on a slower machine. A required field turns that into a startup-visible error.

**Slice 1's ownership rule is unchanged.** The host writes the temporary file, the sidecar deletes it, and the supervisor sweeps orphans on restart. Only the definition of a successful read moves — from "the bytes were counted" to "the Capture is durable" — which is the move Slice 1 said Slice 2 would make.

## Considered Options

- **A `transcribe` call and a separate `ingest` call** — rejected. It is the more composable shape and it is wrong here: it puts the durability boundary between two round trips, and the process holding the transcript in between is the one with no database. It would also make the transcript cross the transport twice for no benefit, having been produced in the process that is about to store it.
- **Keep `readAudio` and add transcription behind it** — rejected as a naming problem that becomes a correctness problem. A method called `readAudio` that also transcribes, persists, and deletes invites a caller to treat it as a read, and the delete-on-success rule is the thing a misread would break.
- **Let the sidecar timestamp at transcription start** — rejected. It is closer to recording-start than transcription-completion is, and still wrong: it varies with how long the file sat between the host writing it and the sidecar picking it up, so identical audio re-uploaded still produces two ids.
- **Have the host embed recording-start in the WAV or the filename** — rejected. It makes the timestamp a parsing problem, and a filename convention is a contract with no type on it. The transport already carries structured parameters.
- **Give the host database access so two calls become safe** — rejected, and out of scope besides. `runtime.md` §1 defers host SQLite access to the first read query that needs it; introducing a second writer to work around a transport shape would trade a solved problem for the concurrency problem WAL's single-writer assumption exists to avoid.

## Consequences

- **`readAudio` is removed rather than deprecated.** It has no production caller — Slice 1 exercised it from `src-tauri/tests/supervisor.rs` — so the rename costs one test update and leaves no compatibility surface. There is no shipped version to keep it for.
- **The transport gains a required timestamp field**, and a malformed one is an error the sidecar reports rather than a value it repairs. Slice 2's verification asserts the rejection directly, since every other guarantee about duplicate suppression rests on the field being real.
- **The accepted crash window is now a structural property, not a convention.** A future change splitting ingestion back into two calls widens it, and the `qa.md` §4.2 test is positioned so that change fails rather than passes quietly.
- **Both capture paths share one ingestion function**, so the write ordering — normalise, timestamp, derive id, write row, then append the event — has one implementation. Slice 2's build order calls that ordering easy to get backwards; two call sites would be two chances to.
- **The `Transcriber` port stays mockable without a binary.** It takes a path and returns text, so steps 1–7 of Slice 2 are testable on a clean checkout; only the integration test needs a real `whisper-cli` and `small.en`, and it is tagged out of the default run alongside the latency and recall measurements.
