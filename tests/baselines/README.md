# Baselines

Committed measurements that later slices must not regress against. Each records
the machine it was taken on, so a cross-machine comparison is visibly
meaningless rather than quietly wrong — re-take them when hardware changes.

`qa.md` §8 is the reason these exist as files rather than as numbers in a commit
message: every bar in the performance suite passes by 20× or better, so a bar
alone will not catch a regression until it is catastrophic. The bar catches a
collapse; the baseline catches the drift that gets you there.

## Present

- **`runtime-latency.json`** — hotkey to a painted capture window (Slice 1).
  Produced by `cargo run --bin measure-latency`, which needs a windowing
  session.

## To be generated on your machine

Neither is committed yet, because a number taken anywhere else describes the
wrong hardware. Both are written by `npm run test:local`.

- **`capture-latency.json`** — text in hand to a durable Capture. Needs nothing
  but a checkout:

  ```sh
  npm run test:local
  ```

- **`transcription-recall.json`** — proper-noun recall on `small.en` (`qa.md`
  §6.4). Needs a `whisper.cpp` build and the recorded corpus described in
  `tests/fixtures/audio/README.md`. It runs against an empty corpus and reports
  `0 clips`, so the file can be generated before the recordings exist — but the
  number is only meaningful once they do.

  ```sh
  OTTO_WHISPER_BIN=/path/to/whisper-cli \
  OTTO_WHISPER_MODEL=/path/to/ggml-small.en.bin \
  npm run test:local
  ```

Commit both once taken. A `whisper.cpp` or model change then shows up as a
visible diff in recall rather than a silent regression.

## Why these are out of the default run

A test leaves `npm test` only when it depends on something a clean checkout does
not have — a whisper build, a recorded corpus, or a known machine class whose
timings mean anything. A shared runner's timing is noise, and a flaky red build
gets deleted rather than fixed. Everything in `qa.md` §4 stays in the default
run, since Tier 0 is what a commit must not break.
