# Slice 1 — Runtime

> Depends on: Slice 0. Blocks: Slice 2.
> Sources: [`add.md`](../add.md) §3, §4, §11; [`runtime.md`](../runtime.md) §1, §2; [`stack.md`](../stack.md) §8; [`qa.md`](../qa.md) §8; ADR-0013.
> Decisions taken here are recorded in [ADR-0017](../adr/0017-pinned-runtime-toolchain-and-sidecar-spawn.md).

## What it closes

Otto is three processes that start, talk, and survive each other's failures. A Tauri host spawns a Node sidecar, they exchange JSON-RPC over stdio, the supervisor restarts the sidecar when it dies, and both build systems are green on one commit.

Nothing a user would recognise. What is true at the end is that every later slice has somewhere to run.

## Why here

This was originally the first three steps of the capture slice, and it was too big there. It introduces a second language, a second build system, a third process, and a CI change before a single Capture is stored — and the estimate for that work is independent of anything about capture. A slice whose first three steps could be its own slice is one that cannot be stopped in the middle, which is the property the slice set exists to provide.

Splitting it also puts the toolchain risk first. If Rust in CI, or the Tauri version, or the sidecar spawn turns out to be a week rather than a day, that is discovered against a slice whose only job is the runtime, not halfway through building capture.

The process model belongs here rather than in Slice 0 because Slice 0 is a library and a test suite (`add.md` §3), and nothing in it needs a process boundary. It belongs *before* capture because capture is what forces three processes: audio and the tray are Rust, the pipeline is TypeScript, and the UI is a WebView (`runtime.md` §1).

## In scope

**The three-process runtime.** Tauri host (Rust), Node sidecar, Svelte WebView, per `runtime.md` §1. JSON-RPC over stdio — no local HTTP port, because there is nothing to conflict with, firewall, or accidentally expose.

**No SQLite in the host.** `runtime.md` §1 describes the steady state as SQLite opened by both processes in WAL mode, the sidecar writing and the host reading. That is the destination, not this slice: nothing here stores anything, so nothing here needs to read it. Adding `rusqlite` now would buy a second SQLite dependency, a second extension-loading story for the vector extension, and a schema the host has to understand — in exchange for no behaviour at all.

It is also a decision better made later on its merits. The host reading the database is what lets it serve the WebView's queries (`add.md` §4), and that commitment belongs where the first read query exists to test it — Slice 6 — rather than here, where there is nothing to read and nothing yet to get wrong. The sidecar opens SQLite in Slice 2 and stays its only user until then.

**`src-tauri/`**, with its own `Cargo.toml`. The Tauri host owns the tray, the global hotkey, the capture window, audio recording, the sidecar's lifecycle, and the JSON-RPC client half of the transport. Nothing else. The host is a shell around OS APIs — no domain types, no persistence, no knowledge of what a Capture means. `add.md` §3's layer rules govern `src/`; the host stays thin enough that they never need to reach it.

**The sidecar supervisor**, restarting on exit with backoff. Because the pipeline is resumable per stage, a restart resumes rather than replays; a crash loop degrades to "captures accumulate," which `add.md` §11 already treats as a handled state. There is nothing to accumulate yet, so the degradation path is tested by injection rather than observed.

**Tray, global hotkey, and an empty capture window.** The window opens, accepts text, and closes. It does not store anything — Slice 2 gives it a `CaptureStore` to write to. Shipping the affordance without the persistence is deliberate: it makes hotkey-to-window latency measurable before there is a pipeline to blame. That is a different measurement from Slice 2's hotkey-to-durable-Capture, not a half of it — this one has no storage under it, and the two keep separate baselines.

**CI building both toolchains.** A commit that breaks `cargo build` fails, exactly as one that breaks `npm run verify` does. This is the first thing built, not the last, because a Rust CI discovered broken at the end of the slice is a Rust CI that gets disabled.

### What this slice decides

Four `stack.md` §8 questions, all of them blocking anything else in Rust:

**The Rust toolchain version**, pinned in `rust-toolchain.toml` so CI and every developer agree. Pin the exact stable release, not `stable` — an unpinned toolchain means a Rust release can break the build on a day nobody touched the code.

**The Tauri major version.** Take the current stable major. This is a one-way door in practice: the plugin ecosystem, the JS API, and the config format all differ across majors, and moving later is a rewrite of the host rather than a version bump.

**The audio-capture crate.** It needs to record from the default input device on all three platforms and write a WAV that `whisper.cpp` accepts. Nothing more — no mixing, no device selection UI, no format conversion beyond what whisper requires.

**How the sidecar is spawned**, which is where the Node-shipping question bites: the host must find a Node runtime to launch. This slice takes the *development* answer only — the host spawns the developer's installed Node, located through a configurable interpreter path. Shipping a runtime inside the installer stays with packaging in Slice 11, and the configurable path is what lets that slice substitute a bundled binary rather than rewriting the supervisor.

Two more that this slice's own build order forces, both smaller but both load-bearing for the slices after it:

**Where the sidecar's TypeScript lives: `src/interfaces/sidecar/`.** The sidecar is a delivery mechanism — it reads stdin, dispatches to a handler, and writes stdout — which is what `add.md` §3 means by `interfaces/`. Putting it there rather than at a top-level `sidecar/` keeps it under the layer rules Slice 0 stood up, so the entrypoint that will eventually reach the pipeline is watched by the same lint that watches everything else. The alternative — a sibling directory outside `src/` — would be a second tree with no boundary rules on it, and the first thing to erode would be the sidecar importing `infrastructure/` directly.

**The host writes temporary audio to an Otto-owned directory**, not the system temp root. The sweep in step 6 has to enumerate the files it is allowed to delete, and a sweep pointed at the system temp directory is a sweep that deletes other applications' files the first time a glob is written badly. A dedicated directory makes the sweep's blast radius the thing Otto created, which is the property worth having before any code deletes anything on a timer.

## Not in scope

- **Storing anything.** Slice 2. The capture window accepts text and discards it; `CaptureStore` does not exist yet.
- **Transcription and the `Transcriber` port.** Slice 2. Audio recording lands here because it is a host concern and the crate choice blocks the toolchain decision; what is done with the audio is capture's business.
- **The pipeline.** There is no extraction, no resolution, nothing for the sidecar to do beyond answer a round-trip call. The sidecar exists here to prove the transport and the supervisor, not to work.
- **The dashboard.** Slice 11. The capture window is a tray affordance, not a window with navigation in it.
- **The installer, code signing, notarisation, and per-platform bundling.** Slice 11. Development here runs `cargo tauri dev`.

## Build order

1. `src-tauri/` skeleton and `rust-toolchain.toml`, with CI extended to build it. Nothing functional — both build systems green on one commit.
2. The Tauri host and the Node sidecar, with JSON-RPC over stdio between them. Prove a round trip: the host calls a method, the sidecar answers, the host receives it.
3. The supervisor: backoff restart, and the crash-loop degradation path.
4. Tray, global hotkey, and the capture window, opening and closing without storing.
5. Audio recording to a temporary file, and the path handoff over the transport. The sidecar reads the file, reports its size, and deletes it — enough to prove the handoff, and the ownership rule, without a transcriber.
6. The orphaned-temporary-file sweep on supervisor restart.

**The sidecar deletes, the host writes.** `runtime.md` §2 puts deletion on the sidecar after a successful transcription, and there is no transcriber here — but the ownership rule is the part worth having under test early, because it is what makes the temporary file safe to share between two processes at all. So the sidecar deletes after a successful *read* in this slice, and Slice 2 moves the delete point later in the same handler once transcription sits in front of it. The alternative — leaving deletion out until there is something to transcribe — ships a slice where the host writes files nobody removes, and makes the sweep in step 6 untestable, since every file would be an orphan.

Which is also what makes step 6 a real test rather than a tautology. Because the sidecar deletes on the success path, the only file still on disk at restart is one whose reader died before it finished — so the sweep has exactly one way to find work, and the test has to produce that failure deliberately rather than just writing a file and waiting. A slice where deletion did not exist yet would leave every file an orphan and the sweep would pass without ever having swept anything.

## Verification

`qa.md` §8's process-model concern, before there is a pipeline to test it against:

- **A round trip completes over the transport.** Host to sidecar and back, asserting the response, not merely that nothing threw.
- **Killing the sidecar restarts it**, with backoff between attempts, and the host stays up. The tray does not die with the sidecar — that is the property the three-process split was chosen for (`runtime.md` §1).
- **A crash loop degrades rather than escalating.** Repeated immediate exits back off rather than spinning, and the host remains responsive throughout.
- **The hotkey opens the capture window with the tray closed and no dashboard**, which is the affordance PRD §5.1 asks for.
- **Audio recorded in the host is readable by the sidecar** at the path it was given, and the file is deleted after a successful read.
- **An orphaned temporary file is swept on restart.** Write one, kill the sidecar before it reads, restart, assert it is gone.
- **Hotkey-to-window latency is under 200 ms**, asserted, with the measured median and p95 recorded. Not a Capture round trip — there is nothing to store — but the window has to be on screen before the user can type into it, which makes this the only part of PRD §4's first principle that is measurable this early.

**The 200 ms bar, and why the baseline matters more.** 200 ms is the point where an opening window stops reading as a response to the keypress and starts reading as a wait; PRD §4 asks for capture that "costs nothing", and nothing here is a keystroke and a caret. It is a generous ceiling on purpose — an empty window with no I/O behind it should land far under, and if it does not, something is wrong with the process model rather than with the budget.

Which is why the assertion alone is not the deliverable. `qa.md` §8 makes the point directly: every bar in the performance suite passes by 20× or better, so a bar alone will not catch a regression until it is catastrophic. Record the median and p95 to `tests/baselines/runtime-latency.json` alongside the machine and OS, the same shape Slice 2 uses for `capture-latency.json` — the 200 ms bar catches a collapse, and the baseline catches the drift that gets you there. Like Slice 2's latency test, this one is tagged out of the default `npm test`: a shared runner's timing is noise, and a flaky red build gets deleted rather than fixed.

## Done when

- `cargo build` and `npm run verify` are both green in CI on one commit.
- The hotkey opens a capture window with the tray closed.
- Killing the sidecar restarts it; killing it repeatedly backs off; the host survives both.
- Audio recorded by the host is read by the sidecar, which deletes it after a successful read; orphans left by a crash are swept on restart.
- Hotkey-to-window latency is under 200 ms, with median and p95 committed to `tests/baselines/runtime-latency.json`.
- The Rust toolchain, Tauri major version, audio crate, and sidecar spawn path are pinned and recorded in `stack.md` §8.
