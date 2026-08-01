import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WhisperCliTranscriber } from "../../src/infrastructure/transcription/whisper-cli-transcriber.js";
import { findWhisper, WHISPER_MISSING } from "../support/local-toolchain.js";
import { loadCorpus, measureRecall } from "../support/transcription-corpus.js";

/**
 * Proper-noun recall on the bundled model (`qa.md` §6.4).
 *
 * There is no pass threshold, and that is deliberate: there is no mitigation to
 * compare against yet. The initial-prompt mitigation needs an entity projection
 * and arrives in Slice 6; transcript correction arrives in Slice 9. This
 * slice's job is to produce the number those slices are measured against.
 *
 * The result is written to `tests/baselines/transcription-recall.json` and
 * checked in, so a `whisper.cpp` or model change is a visible diff in recall
 * rather than a silent regression.
 */
const whisper = findWhisper();
const BASELINE_PATH = join(process.cwd(), "tests/baselines/transcription-recall.json");

describe.skipIf(whisper === null)(`proper-noun recall on small.en (${WHISPER_MISSING})`, () => {
  it("measures recall over the corpus and records it", async () => {
    const corpus = loadCorpus();
    const transcriber = new WhisperCliTranscriber(whisper!);

    const transcripts = new Map<string, string>();
    for (const clip of corpus) {
      const { text } = await transcriber.transcribe(clip.audioPath);
      transcripts.set(clip.name, text);
    }

    const result = measureRecall(transcripts, corpus);
    writeBaseline(result);

    // No threshold. The measurement's job is to produce a number, and an empty
    // corpus produces an honest zero rather than a failure — recording the
    // clips is human work, and the harness must not block on it.
    expect(result.clips).toBe(corpus.length);
    if (corpus.length === 0) {
      console.warn(`0 clips in the corpus; record some in tests/fixtures/audio/`);
    }
  });
});

function writeBaseline(result: ReturnType<typeof measureRecall>): void {
  mkdirSync(join(process.cwd(), "tests/baselines"), { recursive: true });
  const baseline = {
    model: "small.en",
    measuredAt: new Date().toISOString(),
    clips: result.clips,
    expectedProperNouns: result.expected,
    foundProperNouns: result.found,
    recall: Number(result.recall.toFixed(4)),
    misses: result.misses.map(({ clip, properNoun }) => ({ clip, properNoun })),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
}
