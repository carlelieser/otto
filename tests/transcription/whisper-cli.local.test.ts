import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WhisperCliTranscriber } from "../../src/infrastructure/transcription/whisper-cli-transcriber.js";
import { findWhisper, WHISPER_MISSING } from "../support/local-toolchain.js";

/**
 * The one test that needs a real `whisper.cpp` and a real model.
 *
 * Out of the default run because a clean checkout has neither. Everything else
 * about the adapter is unit-tested with the spawn stubbed — this exists to
 * catch the thing a stub cannot: that the flags are right, that the binary
 * actually accepts them, and that stdout parses as expected against the real
 * CLI rather than against an assumption about it.
 */
const whisper = findWhisper();

describe.skipIf(whisper === null)(
  `the adapter drives a real whisper-cli (${WHISPER_MISSING})`,
  () => {
    /**
     * `jfk.wav` ships with `whisper.cpp`. It is used here rather than a corpus
     * clip because this test is about the adapter and the CLI agreeing, not about
     * transcription quality — proper-noun recall is measured separately, against
     * the corpus, in `transcription-recall.local.test.ts`.
     */
    function sampleAudio(): string | null {
      const sample = join(whisper!.binaryPath, "..", "..", "..", "samples", "jfk.wav");
      return existsSync(sample) ? sample : null;
    }

    it("transcribes a real recording to real words", async () => {
      const audioPath = sampleAudio();
      if (audioPath === null) return;
      const transcriber = new WhisperCliTranscriber(whisper!);

      const { text, model } = await transcriber.transcribe(audioPath);

      expect(text.toLowerCase()).toContain("ask not what your country can do for you");
      expect(model).toBe("small.en");
    });

    it("fails loudly on a file that is not audio", async () => {
      const transcriber = new WhisperCliTranscriber(whisper!);

      await expect(transcriber.transcribe("/nonexistent/recording.wav")).rejects.toThrow(
        /Transcribing .* failed/,
      );
    });
  },
);
