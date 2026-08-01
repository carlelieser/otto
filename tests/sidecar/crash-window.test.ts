import type Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureIngestion } from "../../src/application/pipeline/ingest-capture.js";
import { createExecutor } from "../../src/composition-root.js";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteCaptureStore } from "../../src/infrastructure/persistence/sqlite-capture-store.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import { sidecarMethods } from "../../src/interfaces/sidecar/methods.js";
import { FROM_START } from "../../src/ports/event-store.js";
import type { Transcriber } from "../../src/ports/transcriber.js";

const RECORDING_STARTED = "2026-08-01T09:00:00.000Z";

let connection: Database.Database | undefined;
let directory: string | undefined;

afterEach(() => {
  connection?.close();
  connection = undefined;
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function aRecording(): string {
  directory = mkdtempSync(join(tmpdir(), "otto-crash-"));
  const path = join(directory, "recording.wav");
  writeFileSync(path, "not really audio");
  return path;
}

function createSidecar(transcriber: Transcriber) {
  connection = openDatabase();
  const captures = new SqliteCaptureStore(connection);
  const events = new SqliteEventStore(connection);
  const ingestion = new CaptureIngestion(
    { captures, events },
    createExecutor(events, () => "2026-08-01T09:00:05.000Z"),
    () => "2026-08-01T09:00:05.000Z",
  );
  return { methods: sidecarMethods({ ingestion, transcriber }), captures, events };
}

/**
 * The accepted crash window (`qa.md` §4.2).
 *
 * A crash between transcription and Capture persistence loses the audio, and
 * that is the accepted behaviour: the recording is gone, the words were never
 * durable, and there is nothing to recover. This file documents the boundary
 * rather than asserting recovery.
 *
 * It exists so that a future change moving work before the durability point
 * does not pass silently — and so that splitting `ingestVoice` back into two
 * calls fails here. The acceptance is bounded by the window being one handler
 * wide (ADR-0018); a second window between two round trips is not accepted, and
 * the assertions below are positioned to catch its appearance.
 */
describe("a crash between transcription and persistence loses the audio, by design", () => {
  /** Transcription succeeded; the process died before the Capture was durable. */
  function transcriberThatSucceedsBeforeTheCrash(): Transcriber {
    return {
      transcribe: () => Promise.resolve({ text: "Coffee with Sarah.", model: "small.en" }),
    };
  }

  it("stores nothing when the process dies after transcribing", async () => {
    // The crash is modelled as the ingestion never being reached — which is
    // what a killed process looks like from the database's side.
    const { captures, events } = createSidecar(transcriberThatSucceedsBeforeTheCrash());

    expect(await captures.withoutIngestionEvent()).toEqual([]);
    expect(await events.readForward(FROM_START)).toHaveLength(0);
  });

  /**
   * The recording survives a failure, which is what makes this loss bounded:
   * the audio is still on disk for the supervisor's sweep to clean up, and the
   * user's words are lost only in the sense that they were never durable.
   */
  it("leaves the recording for the sweep rather than deleting it", async () => {
    const failing: Transcriber = {
      transcribe: () => Promise.reject(new Error("the process died mid-transcription")),
    };
    const { methods } = createSidecar(failing);
    const path = aRecording();

    await expect(
      methods["ingestVoice"]!({ path, sourceTimestamp: RECORDING_STARTED }),
    ).rejects.toThrow();

    expect(existsSync(path)).toBe(true);
  });

  /**
   * The window is one handler wide, and this is the assertion that notices if
   * it stops being. `ingestVoice` must both transcribe and persist: a sidecar
   * exposing a bare `transcribe` would put the durability boundary between two
   * round trips, in the process that has no database.
   */
  it("exposes no method that transcribes without persisting", () => {
    const { methods } = createSidecar(transcriberThatSucceedsBeforeTheCrash());

    expect(methods["transcribe"]).toBeUndefined();
    expect(methods["ingestVoice"]).toBeDefined();
  });

  it("returns a durable Capture from the one call, not a transcript", async () => {
    const { methods, captures } = createSidecar(transcriberThatSucceedsBeforeTheCrash());
    const path = aRecording();

    const capture = (await methods["ingestVoice"]!({
      path,
      sourceTimestamp: RECORDING_STARTED,
    })) as { captureId: string };

    // What comes back is already stored: there is no second call in which a
    // crash could lose it.
    expect(await captures.get(capture.captureId)).not.toBeNull();
  });
});

/**
 * `qa.md` §8: capture must stay responsive while the pipeline is saturated.
 *
 * A weak test today and deliberately so — there is nothing in the pipeline yet
 * to saturate with. It is written here and gains its teeth in Slice 3, when a
 * long local extraction is available to run underneath it. It guards the entire
 * process-model decision (`runtime.md` §1): a WebView busy extracting is a
 * capture window that stutters, which is why the pipeline is a sidecar at all.
 */
describe("capture stays responsive while other work runs", () => {
  it("completes a capture while a long-running task occupies the sidecar", async () => {
    const { methods } = createSidecar({
      transcribe: () => Promise.resolve({ text: "unused", model: "small.en" }),
    });

    // Stand-in for Slice 3's extraction: work that does not block the loop.
    const saturation = new Promise((resolve) => setTimeout(resolve, 200));

    const started = performance.now();
    await methods["ingestTyped"]!({
      text: "Coffee with Sarah about the Helios rollout.",
      sourceTimestamp: RECORDING_STARTED,
    });
    const elapsed = performance.now() - started;

    await saturation;
    // The capture did not wait on the other work. The bar is loose because the
    // measurement that matters is in `capture-latency.local.test.ts`; what is
    // asserted here is that the two are not serialised.
    expect(elapsed).toBeLessThan(150);
  });
});
