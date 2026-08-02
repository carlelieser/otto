# Otto

A private, local, cross-platform system for personal knowledge — the people,
projects, ideas, events, and tasks in one person's life, and how their
understanding of those things changes over time.

Start with [`CONTEXT.md`](./CONTEXT.md) for the vocabulary and
[`docs/`](./docs/README.md) for the architecture, the plan, and the decisions.

## Running it

Three processes: a Tauri host in Rust, a Node sidecar running the pipeline, and
a WebView (`runtime.md` §1).

```sh
npm ci
npm run build:sidecar
cargo tauri dev --manifest-path src-tauri/Cargo.toml
```

The global hotkey is <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd>.

## Verifying

```sh
npm run verify                                  # format, types, and the suite
cargo test --manifest-path src-tauri/Cargo.toml  # the host and the supervisor
```

The Rust integration tests drive a real spawned sidecar, so `npm run
build:sidecar` has to have run first.

## Voice capture

Voice needs a local `whisper.cpp` build and the `small.en` model — bundled in
Slice 11, built by hand until then.

```sh
git clone --depth 1 https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j
sh ./models/download-ggml-model.sh small.en
```

Point Otto at it:

```sh
export OTTO_WHISPER_BIN=/path/to/whisper.cpp/build/bin/whisper-cli
export OTTO_WHISPER_MODEL=/path/to/whisper.cpp/models/ggml-small.en.bin
```

Swapping in `large-v3` is a change to `OTTO_WHISPER_MODEL` and nothing else: the
adapter shells out to the binary, and the model name recorded on each Capture is
read from the filename.

## Measurements

The measurements and the one integration test needing a real binary are out of
the default run — a clean checkout has no whisper build, and a shared runner's
timing is noise (`qa.md` §8).

```sh
npm run test:local
```

See [`tests/baselines/README.md`](./tests/baselines/README.md) for what each
baseline records and [`tests/fixtures/audio/README.md`](./tests/fixtures/audio/README.md)
for the transcription corpus, which is hand-recorded.

## Environment

| Variable | What it does | Default |
| --- | --- | --- |
| `OTTO_DATABASE` | Where the sidecar's SQLite file lives | the app data directory |
| `OTTO_NODE` | The Node interpreter the host spawns | `node` |
| `OTTO_SIDECAR` | The built sidecar script | `dist/sidecar/main.js` |
| `OTTO_WHISPER_BIN` | The `whisper-cli` executable | `whisper-cli` |
| `OTTO_WHISPER_MODEL` | The `ggml-*.bin` model file | `models/ggml-small.en.bin` |
