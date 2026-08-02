import { describe, expect, it, vi } from "vitest";
import {
  type SpawnProcess,
  WhisperCliTranscriber,
} from "../../src/infrastructure/transcription/whisper-cli-transcriber.js";

const MODEL_PATH = "/models/ggml-small.en.bin";
const BINARY_PATH = "/bin/whisper-cli";

function transcriberSpawning(stdout: string, spy?: SpawnProcess): WhisperCliTranscriber {
  return new WhisperCliTranscriber({
    binaryPath: BINARY_PATH,
    modelPath: MODEL_PATH,
    spawn: spy ?? (() => Promise.resolve({ stdout })),
  });
}

/**
 * The adapter with its spawn stubbed. The `Transcriber` port takes a path and
 * returns text, so everything about the adapter except the binary itself is
 * testable on a clean checkout — which is what keeps the local-toolchain
 * dependency confined to the integration test below.
 */
describe("the whisper-cli adapter reads a transcript from the CLI", () => {
  it("returns the text the CLI printed", async () => {
    const transcriber = transcriberSpawning("\n And so, my fellow Americans. ");

    const { text } = await transcriber.transcribe("/tmp/recording.wav");

    expect(text).toBe(" And so, my fellow Americans.");
  });

  it("passes the model, the audio path, and the quiet flags", async () => {
    const spawn = vi.fn().mockResolvedValue({ stdout: "\ntext " });
    const transcriber = transcriberSpawning("", spawn);

    await transcriber.transcribe("/tmp/recording.wav");

    expect(spawn).toHaveBeenCalledWith(BINARY_PATH, [
      "--model",
      MODEL_PATH,
      "--file",
      "/tmp/recording.wav",
      "--no-prints",
      "--no-timestamps",
    ]);
  });

  /**
   * The transcript's own whitespace survives, because `content_hash` covers the
   * raw text: trimming here would change every id in the system. Only the
   * framing the CLI adds is removed.
   */
  it("strips the CLI's framing without touching the transcript's whitespace", async () => {
    const transcriber = transcriberSpawning("\n  Coffee   with Sarah.  ");

    const { text } = await transcriber.transcribe("/tmp/recording.wav");

    expect(text).toBe("  Coffee   with Sarah.");
  });

  it("keeps an empty transcript empty rather than inventing text", async () => {
    const transcriber = transcriberSpawning("\n \n");

    expect((await transcriber.transcribe("/tmp/silence.wav")).text).toBe("");
  });
});

describe("the adapter reports the model that produced the transcript", () => {
  it("takes the model name from the model file", async () => {
    const transcriber = transcriberSpawning("\ntext ");

    expect((await transcriber.transcribe("/tmp/recording.wav")).model).toBe("small.en");
  });

  it("reports a different model when pointed at a different file", async () => {
    const transcriber = new WhisperCliTranscriber({
      binaryPath: BINARY_PATH,
      modelPath: "/models/ggml-large-v3.bin",
      spawn: () => Promise.resolve({ stdout: "\ntext " }),
    });

    expect((await transcriber.transcribe("/tmp/recording.wav")).model).toBe("large-v3");
  });

  it("refuses a model path that is not a ggml file, rather than guessing a name", async () => {
    const transcriber = new WhisperCliTranscriber({
      binaryPath: BINARY_PATH,
      modelPath: "/models/small.en",
      spawn: () => Promise.resolve({ stdout: "\ntext " }),
    });

    await expect(transcriber.transcribe("/tmp/recording.wav")).rejects.toThrow(
      /not a ggml-<model>\.bin file/,
    );
  });
});

/**
 * A failed transcription and a silent recording are different facts. An adapter
 * that returned an empty string for a crashed binary would let the caller
 * durably store silence as a Capture.
 */
describe("the adapter fails loudly when the CLI does", () => {
  it("throws naming the audio path and the model", async () => {
    const transcriber = transcriberSpawning("", () =>
      Promise.reject(new Error("whisper-cli: no such file")),
    );

    await expect(transcriber.transcribe("/tmp/missing.wav")).rejects.toThrow(
      /Transcribing \/tmp\/missing\.wav with \/models\/ggml-small\.en\.bin failed/,
    );
  });

  it("keeps the underlying failure as the cause", async () => {
    const cause = new Error("whisper-cli: no such file");
    const transcriber = transcriberSpawning("", () => Promise.reject(cause));

    await expect(transcriber.transcribe("/tmp/missing.wav")).rejects.toMatchObject({ cause });
  });
});
