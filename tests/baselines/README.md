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

- **`vector-search.json`** — top-20 over 3,000 entity embeddings (Slice 4).
  This is the re-measurement `runtime.md` §4.3 asked for: the 0.3 ms row in
  `runtime.md` §4 was taken on `asg017/sqlite-vec` 0.1.9, which is neither the
  extension §4.3 named nor the implementation ADR-0021 settled on. Written by
  `npm run test:local` and committed, because the machine is recorded with it.

  **It is the tightest margin among the single-query rows** — 13.8 ms against a
  100 ms bar — so it is the row that moves first. The scan is linear in entity
  count, which is what to watch.

- **`projection-performance.json`** — `qa.md` §8's remaining six bars against
  the real projector, on the 10,000-Capture corpus (Slice 6). Written by
  `npm run test:local`.

  Four rows are at or better than the spike's baseline. Two are not, and the
  gap is structural rather than a regression: rebuild is 8.4 s against 215 ms,
  and 100-event catch-up is 145 ms against 11.6 ms. The spike's projection
  logic was a stand-in that wrote entity rows only; this projector also writes
  a provenance row per field and maintains an FTS index, which is roughly three
  writes per event where the spike did one. Both stay inside their bars, at 7×
  and 3.5×.

  **These two rows are where the suite has the least headroom**, so they are
  what a later slice should watch. The file records what would count as a
  regression and where to look first.

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
