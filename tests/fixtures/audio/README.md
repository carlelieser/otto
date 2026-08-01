# The transcription corpus

Labelled audio for the proper-noun recall measurement (`qa.md` §6.4). Recording
the clips is human work and is the only part of Slice 2 that cannot be
delegated — the harness runs against an empty directory and reports "0 clips",
so the corpus arriving is a data change rather than a code change.

## What to record

**Thirty to fifty clips, five to twenty seconds each**, self-recorded, each a
plausible Otto capture — the kind of thing you would actually press the hotkey
to say.

It is deliberately small and deliberately hand-made. This measures whether
`small.en` keeps *names* intact, not general accuracy, so coverage of hard names
beats volume. Weight it toward the three places a small model fails:

- **Common-word homophones** — Mark, Bill, Rose, Ross, Grant, Faith, Hope.
- **Non-English spellings** — Siobhán, Xiuying, Nnamdi, Þór, Jørgen, Okonkwo.
- **Initialisms** — ACME, NDA, Q3, SRE, KPI, RFP.

Mix them into ordinary sentences rather than reading name lists: the model has
more trouble with a name in running speech, which is also the only way one ever
arrives in a real Capture.

## Format

WAV, 16 kHz mono 16-bit — what the host records and what `whisper.cpp` accepts
without resampling (`src-tauri/src/audio.rs`).

Each clip needs a sibling JSON file naming the proper nouns a correct transcript
must contain. A clip without one is skipped rather than failing.

```
tests/fixtures/audio/
  coffee-with-siobhan.wav
  coffee-with-siobhan.json
```

```json
{
  "properNouns": ["Siobhán", "Helios", "Q3"]
}
```

List only the proper nouns, not the whole transcript. The metric is the fraction
of them appearing exactly in what the transcriber produced — exact because
"Sarah" transcribed as "Sara" is a resolution problem, which is precisely what
makes name accuracy the metric that matters rather than general WER.

## Running it

```sh
OTTO_WHISPER_BIN=/path/to/whisper-cli \
OTTO_WHISPER_MODEL=/path/to/ggml-small.en.bin \
npm run test:local
```

The result is written to `tests/baselines/transcription-recall.json` and checked
in, so a `whisper.cpp` or model change shows up as a visible diff in recall
rather than a silent regression.

There is **no pass threshold**, and that is deliberate: there is nothing to
compare against yet. The initial-prompt mitigation needs an entity projection
and arrives in Slice 6; transcript correction arrives in Slice 9. This slice's
job is to produce the number those slices are measured against.
