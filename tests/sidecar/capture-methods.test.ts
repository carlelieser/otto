import type Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureIngestion } from "../../src/application/pipeline/ingest-capture.js";
import { createExecutor } from "../../src/composition-root.js";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteCaptureStore } from "../../src/infrastructure/persistence/sqlite-capture-store.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import { sidecarMethods } from "../../src/interfaces/sidecar/methods.js";
import type { Capture } from "../../src/ports/capture-store.js";
import { FROM_START } from "../../src/ports/event-store.js";
import type { EventStore } from "../../src/ports/event-store.js";
import type { Transcriber } from "../../src/ports/transcriber.js";

const RECORDING_STARTED = "2026-08-01T09:00:00.000Z";
const INGESTED_AT = "2026-08-01T09:00:05.000Z";

let connection: Database.Database | undefined;
let directory: string | undefined;

afterEach(() => {
  connection?.close();
  connection = undefined;
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

/** A transcriber that answers with fixed text, and records what it was asked. */
function stubTranscriber(text = "Coffee with Sarah.", model = "small.en"): Transcriber {
  return { transcribe: vi.fn().mockResolvedValue({ text, model }) };
}

function createSidecar(transcriber: Transcriber = stubTranscriber()) {
  connection = openDatabase();
  const captures = new SqliteCaptureStore(connection);
  const events: EventStore = new SqliteEventStore(connection);
  const ingestion = new CaptureIngestion(
    { captures, events },
    createExecutor(events, () => INGESTED_AT),
    () => INGESTED_AT,
  );
  return { methods: sidecarMethods({ ingestion, transcriber }), captures, events, transcriber };
}

/** A temporary WAV standing in for one the host recorded. */
function aRecording(): string {
  directory = mkdtempSync(join(tmpdir(), "otto-capture-"));
  const path = join(directory, "recording.wav");
  writeFileSync(path, "not really audio");
  return path;
}

describe("the sidecar exposes the two capture methods", () => {
  it("no longer answers Slice 1's readAudio placeholder", () => {
    // ADR-0018: removed rather than deprecated. It had no production caller, so
    // there is no compatibility surface to keep.
    const { methods } = createSidecar();
    expect(methods["readAudio"]).toBeUndefined();
  });

  it("still answers ping, which the supervisor's round trip depends on", () => {
    const { methods } = createSidecar();
    expect(methods["ping"]).toBeDefined();
  });

  it("omits the capture methods when there is nothing to ingest with", () => {
    // The transport and the supervisor stay testable without a database.
    const methods = sidecarMethods();
    expect(methods["ingestTyped"]).toBeUndefined();
    expect(methods["ingestVoice"]).toBeUndefined();
  });
});

describe("ingestTyped stores what the user typed", () => {
  it("returns a durable Capture", async () => {
    const { methods, captures } = createSidecar();

    const capture = (await methods["ingestTyped"]!({
      text: "Coffee with Sarah.",
      sourceTimestamp: RECORDING_STARTED,
    })) as Capture;

    expect(capture.source).toBe("typed");
    expect(await captures.get(capture.captureId)).toEqual(capture);
  });

  it("records no transcription model, because nothing transcribed it", async () => {
    const { methods } = createSidecar();

    const capture = (await methods["ingestTyped"]!({
      text: "Coffee with Sarah.",
      sourceTimestamp: RECORDING_STARTED,
    })) as Capture;

    expect(capture.transcriptionModel).toBeNull();
  });

  it("refuses a request with no text", async () => {
    const { methods } = createSidecar();

    await expect(methods["ingestTyped"]!({ sourceTimestamp: RECORDING_STARTED })).rejects.toThrow(
      /requires text/,
    );
  });
});

describe("ingestVoice transcribes, persists, and only then deletes", () => {
  it("returns a durable Capture carrying the transcript", async () => {
    const { methods, captures } = createSidecar();
    const path = aRecording();

    const capture = (await methods["ingestVoice"]!({
      path,
      sourceTimestamp: RECORDING_STARTED,
    })) as Capture;

    expect(capture.source).toBe("voice");
    expect(capture.rawText).toBe("Coffee with Sarah.");
    expect(await captures.get(capture.captureId)).toEqual(capture);
  });

  it("records the model that produced the transcript", async () => {
    const { methods } = createSidecar(stubTranscriber("Coffee with Sarah.", "large-v3"));
    const path = aRecording();

    const capture = (await methods["ingestVoice"]!({
      path,
      sourceTimestamp: RECORDING_STARTED,
    })) as Capture;

    expect(capture.transcriptionModel).toBe("large-v3");
  });

  it("deletes the recording once the Capture is durable", async () => {
    const { methods } = createSidecar();
    const path = aRecording();

    await methods["ingestVoice"]!({ path, sourceTimestamp: RECORDING_STARTED });

    expect(existsSync(path)).toBe(false);
  });

  /**
   * Slice 1's ownership rule, with only the definition of "successful" moved:
   * a file left behind by a failure is an orphan the supervisor sweeps on
   * restart, which is recoverable. Deleting before the Capture is durable would
   * lose the audio with nothing to show for it.
   */
  it("leaves the recording on disk when transcription fails", async () => {
    const failing: Transcriber = {
      transcribe: () => Promise.reject(new Error("whisper-cli crashed")),
    };
    const { methods } = createSidecar(failing);
    const path = aRecording();

    await expect(
      methods["ingestVoice"]!({ path, sourceTimestamp: RECORDING_STARTED }),
    ).rejects.toThrow(/whisper-cli crashed/);

    expect(existsSync(path)).toBe(true);
  });

  it("leaves the recording on disk when the Capture cannot be stored", async () => {
    const { methods, events } = createSidecar();
    vi.spyOn(events, "append").mockRejectedValueOnce(new Error("the log is unavailable"));
    const path = aRecording();

    await expect(
      methods["ingestVoice"]!({ path, sourceTimestamp: RECORDING_STARTED }),
    ).rejects.toThrow(/log is unavailable/);

    expect(existsSync(path)).toBe(true);
  });

  it("refuses a request with no path", async () => {
    const { methods } = createSidecar();

    await expect(methods["ingestVoice"]!({ sourceTimestamp: RECORDING_STARTED })).rejects.toThrow(
      /requires a path/,
    );
  });
});

/**
 * The whole of the retried-upload guarantee rests on the host supplying
 * recording-start, so its absence has to be loud (ADR-0018). A sidecar that
 * fell back to its own clock would record transcription-completion time under
 * recording-start's name, and the resulting bug is timing-dependent.
 */
describe("ingestVoice requires recording-start rather than substituting its own clock", () => {
  it.each([
    ["absent", undefined],
    ["not a string", 1_754_038_800_000],
    ["a date without a time", "2026-08-01"],
    ["seconds precision", "2026-08-01T09:00:00Z"],
    ["an offset rather than Z", "2026-08-01T09:00:00.000+00:00"],
    ["local time", "2026-08-01T09:00:00.000"],
  ])("refuses a sourceTimestamp that is %s", async (_case, sourceTimestamp) => {
    const { methods } = createSidecar();
    const path = aRecording();

    await expect(methods["ingestVoice"]!({ path, sourceTimestamp })).rejects.toThrow(
      /requires sourceTimestamp as YYYY-MM-DDTHH:MM:SS\.sssZ/,
    );
  });

  it("leaves the recording on disk when it refuses", async () => {
    const { methods } = createSidecar();
    const path = aRecording();

    await expect(methods["ingestVoice"]!({ path })).rejects.toThrow(/sourceTimestamp/);

    expect(existsSync(path)).toBe(true);
  });

  it("refuses a malformed sourceTimestamp on the typed path too", async () => {
    const { methods } = createSidecar();

    await expect(
      methods["ingestTyped"]!({ text: "Coffee", sourceTimestamp: "yesterday" }),
    ).rejects.toThrow(/requires sourceTimestamp/);
  });
});

/**
 * `qa.md` §4.3's retried upload, asserted against a transcriber that takes
 * visibly different durations on the two runs. An implementation that quietly
 * timestamped at transcription-completion would produce two ids here rather
 * than failing intermittently in production.
 */
describe("a retried upload of identical audio produces one Capture", () => {
  function slowingTranscriber(): Transcriber {
    let call = 0;
    return {
      transcribe: async () => {
        call += 1;
        await new Promise((resolve) => setTimeout(resolve, call === 1 ? 1 : 40));
        return { text: "Coffee with Sarah.", model: "small.en" };
      },
    };
  }

  it("yields the same capture id despite different transcription durations", async () => {
    const { methods } = createSidecar(slowingTranscriber());
    const first = (await methods["ingestVoice"]!({
      path: aRecording(),
      sourceTimestamp: RECORDING_STARTED,
    })) as Capture;
    const second = (await methods["ingestVoice"]!({
      path: aRecording(),
      sourceTimestamp: RECORDING_STARTED,
    })) as Capture;

    expect(second.captureId).toBe(first.captureId);
  });

  it("appends one event for the two deliveries", async () => {
    const { methods, events } = createSidecar(slowingTranscriber());

    await methods["ingestVoice"]!({ path: aRecording(), sourceTimestamp: RECORDING_STARTED });
    await methods["ingestVoice"]!({ path: aRecording(), sourceTimestamp: RECORDING_STARTED });

    expect(await events.readForward(FROM_START)).toHaveLength(1);
  });
});
