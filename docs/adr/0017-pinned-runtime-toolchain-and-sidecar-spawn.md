# The runtime toolchain is pinned, and the sidecar is spawned through a configurable interpreter

---
Status: accepted
---

ADR-0013 settled *that* the pipeline runs as a Node sidecar under a Tauri host over stdio JSON-RPC. It did not name a Rust toolchain, a Tauri major version, an audio-capture crate, or say how the host finds a Node runtime to launch — and `stack.md` §8 carried all four as open. They are construction-technique and dependency choices in the sense AGENTS.md means: each one couples the host to an ecosystem, and three of the four are expensive to reverse. Slice 1 had to settle them to build anything in Rust at all.

**The Rust toolchain is pinned to an exact stable release** in `rust-toolchain.toml`, not to `stable`. An unpinned toolchain means a Rust release can break the build on a day nobody touched the code, and the failure arrives attached to whichever commit happened to be pushed that morning. CI reads the same file every developer does, so there is one version and it is written down once.

**Tauri 2 is the major version.** This is a one-way door in practice rather than in principle: the plugin ecosystem, the JS API, and the configuration format all differ across majors, so moving later is a rewrite of the host rather than a version bump. Taking the current stable major is the choice that buys the longest runway before that rewrite is forced.

**Audio capture is `cpal`, and the WAV is written by `hound`.** The requirement is narrow — record from the default input device on all three platforms and produce a file `whisper.cpp` accepts (`runtime.md` §2) — and these two cover exactly it. No mixing, no device-selection UI, no format conversion beyond the 16 kHz mono 16-bit that whisper wants. The narrowness is the point: an audio abstraction that does more than this slice needs is one whose shape is guessed rather than derived.

**The sidecar is spawned through a configurable interpreter path.** The host launches an installed Node located by `OTTO_NODE`, running the script at `OTTO_SIDECAR`. This is deliberately the *development* answer to the Node-shipping question and not the shipping one: how a runtime gets into the installer is a packaging decision that belongs with packaging (Slice 11, `stack.md` §8). What this ADR fixes is that the substitution point exists and is one function wide, so shipping a bundled runtime later is a configuration change rather than a supervisor rewrite.

Two smaller placements follow from the layering rules rather than from the toolchain, and are recorded here because both are interface decisions that later slices build on:

**The sidecar's TypeScript lives at `src/interfaces/sidecar/`.** It reads stdin, dispatches, and writes stdout, which is what `add.md` §3 means by `interfaces/`. Placing it inside `src/` keeps it under the boundary rules Slice 0 stood up, so the entrypoint that eventually reaches the pipeline is watched by the same lint as everything else.

**Temporary recordings go to an Otto-owned directory**, not the system temp root. The supervisor's orphan sweep deletes files it did not create the moment a pattern is written badly, and scoping it to a directory Otto made keeps the blast radius to what Otto owns.

## Considered Options

- **Track `stable` rather than pinning** — rejected. It trades a reproducible build for never having to bump a number, and the cost lands as a red build on an unrelated commit.
- **Wait for Tauri 3, or track the pre-release** — rejected. There is no version that is not eventually superseded, and building against a moving target to avoid a future migration pays the migration continuously instead of once.
- **A higher-level audio crate, or one that also transcribes** — rejected. Transcription sits behind the `Transcriber` port and `ports/` is TypeScript (`runtime.md` §2); a Rust crate that did both would put a port implementation in a language with no ports directory and no lint rule watching the boundary.
- **Bundle a Node runtime now** — rejected as premature. It is a packaging decision with per-platform consequences, and making it in the runtime slice would settle it without the installer work that would test it.
- **Write the sidecar outside `src/`** — rejected. A second tree with no boundary rules on it, and the first thing to erode would be the sidecar importing `infrastructure/` directly.
- **Sweep the system temp directory** — rejected. A sweep that runs on every restart and deletes by pattern must not be pointed at a directory shared with every other application on the machine.

## Consequences

- **Bumping Rust or Tauri is now a deliberate, reviewable commit** rather than something that happens to a developer. That is the intended cost: the version moves when someone decides it should.
- **CI builds two toolchains**, and a commit that breaks `cargo build` fails exactly as one that breaks `npm run verify` does. Slice 1 put the Rust job in CI first rather than last, because a Rust CI discovered broken at the end of a slice is one that gets disabled.
- **The Linux CI runner needs system WebKit and tray dependencies** for Tauri to build at all. This is a fixed cost of the Tauri choice and is paid in the workflow rather than worked around.
- **`cpal` and `hound` join the dependency surface the installer must carry**, alongside `whisper.cpp`, the embedding model, and the vector extension (`runtime.md` §4.3). Slice 11 sees all of them together.
- **The spawn path is environment-configurable**, which is what makes the development answer above safe to ship now. It also means a misconfigured `OTTO_NODE` is a startup failure the supervisor reports rather than a crash, since a sidecar that will not start is already a state the crash-loop degradation handles (`add.md` §11).
- **`whisper.cpp` is not reached in this ADR.** Audio recording lands in the host because that is where the OS APIs are; what is done with the audio stays capture's business, and Slice 2 settles how the sidecar invokes the transcriber.
