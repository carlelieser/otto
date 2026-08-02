import { describe, expect, it } from "vitest";
import {
  createExecutor,
  createIngestion,
  createStorage,
  type Storage,
} from "../../src/composition-root.js";
import { TranscriptCorrection } from "../../src/application/pipeline/correct-transcript.js";
import { CAPTURE_TRANSCRIPT_CORRECTED } from "../../src/domain/events/capture-corrected.js";
import { CAPTURE_INGESTED } from "../../src/domain/events/capture-ingested.js";
import { FROM_START } from "../../src/ports/event-store.js";
import type { Capture } from "../../src/ports/capture-store.js";

const AT = "2026-08-02T10:00:00.000Z";

/** A voice Capture with a misheard name, stored and ingested for real. */
async function aMisheardVoiceCapture(storage: Storage): Promise<Capture> {
  return createIngestion(storage, () => AT).ingest({
    source: "voice",
    rawText: "Coffee with Sara about the Helios rollout.",
    sourceTimestamp: "2026-08-01T09:00:00.000Z",
    transcriptionModel: "small.en",
  });
}

function aCorrection(storage: Storage): TranscriptCorrection {
  return new TranscriptCorrection({
    captures: storage.captures,
    executor: createExecutor(storage.events, () => AT),
    currentVersionOf: (id) => storage.events.currentVersion(id),
    now: () => AT,
  });
}

describe("correcting a transcript appends rather than overwrites", () => {
  it("appends CaptureTranscriptCorrected carrying the corrected text", async () => {
    const storage = createStorage();
    const capture = await aMisheardVoiceCapture(storage);

    await aCorrection(storage).correct(
      capture.captureId,
      "Coffee with Sarah about the Helios rollout.",
    );

    const events = await storage.events.readForward(FROM_START);
    const corrected = events.find((event) => event.type === CAPTURE_TRANSCRIPT_CORRECTED);
    expect(corrected?.payload).toMatchObject({
      captureId: capture.captureId,
      correctedText: "Coffee with Sarah about the Helios rollout.",
    });
    storage.close();
  });

  /**
   * The rule this slice must not weaken. The raw transcript is still exactly
   * what the transcriber produced, and the ingestion event still carries it.
   */
  it("leaves the raw transcript provably unmodified", async () => {
    const storage = createStorage();
    const capture = await aMisheardVoiceCapture(storage);

    await aCorrection(storage).correct(
      capture.captureId,
      "Coffee with Sarah about the Helios rollout.",
    );

    const stored = await storage.captures.get(capture.captureId);
    expect(stored?.rawText).toBe("Coffee with Sara about the Helios rollout.");
    expect(stored?.contentHash).toBe(capture.contentHash);
    storage.close();
  });

  it("keeps both texts readable", async () => {
    const storage = createStorage();
    const capture = await aMisheardVoiceCapture(storage);

    await aCorrection(storage).correct(
      capture.captureId,
      "Coffee with Sarah about the Helios rollout.",
    );

    const stored = await storage.captures.get(capture.captureId);
    expect(stored?.rawText).toBe("Coffee with Sara about the Helios rollout.");
    expect(stored?.correctedText).toBe("Coffee with Sarah about the Helios rollout.");
    storage.close();
  });

  it("keeps the ingestion event on the log beside the correction", async () => {
    const storage = createStorage();
    const capture = await aMisheardVoiceCapture(storage);

    await aCorrection(storage).correct(capture.captureId, "Coffee with Sarah.");

    const types = (await storage.events.readForward(FROM_START)).map((event) => event.type);
    expect(types).toEqual([CAPTURE_INGESTED, CAPTURE_TRANSCRIPT_CORRECTED]);
    storage.close();
  });

  /**
   * The correction is the user's own statement about what was said, so it
   * carries a human's provenance: no model proposed it and there is no
   * Confidence to record (ADR-0002).
   */
  it("records the correction as human-confirmed", async () => {
    const storage = createStorage();
    const capture = await aMisheardVoiceCapture(storage);

    await aCorrection(storage).correct(capture.captureId, "Coffee with Sarah.");

    const events = await storage.events.readForward(FROM_START);
    const corrected = events.find((event) => event.type === CAPTURE_TRANSCRIPT_CORRECTED);
    expect(corrected?.provenance.isHumanConfirmed).toBe(true);
    expect(corrected?.provenance.confidence).toBeNull();
    expect(corrected?.provenance.captureId).toBe(capture.captureId);
    storage.close();
  });

  /** The Capture aggregate's version 1, which is what makes the check live. */
  it("moves the Capture aggregate to version 1", async () => {
    const storage = createStorage();
    const capture = await aMisheardVoiceCapture(storage);

    await aCorrection(storage).correct(capture.captureId, "Coffee with Sarah.");

    expect(await storage.events.currentVersion(capture.captureId)).toBe(2);
    storage.close();
  });
});

/**
 * PRD §5.5 and §6: typed Captures were not misheard, and editing one would make
 * Otto a document editor. The refusal is here rather than in the UI, so a
 * caller reaching the stage directly cannot do what the surface declines to
 * offer.
 */
describe("a typed Capture is not correctable", () => {
  it("refuses to correct a typed Capture", async () => {
    const storage = createStorage();
    const typed = await createIngestion(storage, () => AT).ingest({
      source: "typed",
      rawText: "Coffee with Sarah.",
      sourceTimestamp: "2026-08-01T09:00:00.000Z",
      transcriptionModel: null,
    });

    await expect(
      aCorrection(storage).correct(typed.captureId, "Coffee with Sara."),
    ).rejects.toThrow(/typed/i);
    storage.close();
  });

  it("appends nothing when it refuses", async () => {
    const storage = createStorage();
    const typed = await createIngestion(storage, () => AT).ingest({
      source: "typed",
      rawText: "Coffee with Sarah.",
      sourceTimestamp: "2026-08-01T09:00:00.000Z",
      transcriptionModel: null,
    });

    await expect(aCorrection(storage).correct(typed.captureId, "x")).rejects.toThrow();

    const types = (await storage.events.readForward(FROM_START)).map((event) => event.type);
    expect(types).toEqual([CAPTURE_INGESTED]);
    storage.close();
  });
});

describe("a correction names the Capture it could not find", () => {
  it("refuses a Capture that is not stored", async () => {
    const storage = createStorage();

    await expect(aCorrection(storage).correct("cap-nothing", "text")).rejects.toThrow(
      /cap-nothing/,
    );
    storage.close();
  });

  it("refuses empty corrected text", async () => {
    const storage = createStorage();
    const capture = await aMisheardVoiceCapture(storage);

    await expect(aCorrection(storage).correct(capture.captureId, "   ")).rejects.toThrow();
    storage.close();
  });
});
