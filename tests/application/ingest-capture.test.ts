import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureIngestion } from "../../src/application/pipeline/ingest-capture.js";
import { CaptureRecovery } from "../../src/application/pipeline/recover-captures.js";
import { createExecutor } from "../../src/composition-root.js";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteCaptureStore } from "../../src/infrastructure/persistence/sqlite-capture-store.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import { CAPTURE_INGESTED } from "../../src/domain/events/capture-ingested.js";
import type { Capture, CaptureStore } from "../../src/ports/capture-store.js";
import type { EventStore } from "../../src/ports/event-store.js";
import { FROM_START } from "../../src/ports/event-store.js";

const INGESTED_AT = "2026-08-01T09:00:01.000Z";

const A_TYPED_CAPTURE = {
  source: "typed",
  rawText: "Coffee with Sarah about the Helios rollout.",
  sourceTimestamp: "2026-08-01T09:00:00.000Z",
  transcriptionModel: null,
} as const;

let connection: Database.Database | undefined;

afterEach(() => {
  connection?.close();
  connection = undefined;
});

interface Harness {
  readonly ingestion: CaptureIngestion;
  readonly recovery: CaptureRecovery;
  readonly captures: CaptureStore;
  readonly events: EventStore;
}

function createHarness(): Harness {
  connection = openDatabase();
  const captures = new SqliteCaptureStore(connection);
  const events = new SqliteEventStore(connection);
  const ingestion = new CaptureIngestion(
    { captures, events },
    createExecutor(events),
    () => INGESTED_AT,
  );
  return { ingestion, recovery: new CaptureRecovery(captures, ingestion), captures, events };
}

describe("ingestion turns arriving input into a durable Capture", () => {
  it("stores the Capture and appends its event", async () => {
    const { ingestion, captures, events } = createHarness();

    const capture = await ingestion.ingest(A_TYPED_CAPTURE);

    expect(await captures.get(capture.captureId)).toEqual(capture);
    const [stored] = await events.readForward(FROM_START);
    expect(stored?.type).toBe(CAPTURE_INGESTED);
  });

  it("derives the Capture id from the input rather than inventing one", async () => {
    const { ingestion } = createHarness();

    const capture = await ingestion.ingest(A_TYPED_CAPTURE);

    expect(capture.captureId).toBe("cap-0ee28d5f3077a14b63959caaf2f7415a");
  });

  it("keeps raw text unnormalised on the Capture", async () => {
    const { ingestion } = createHarness();
    const rawText = "  Coffee   with\n\nSarah  ";

    const capture = await ingestion.ingest({ ...A_TYPED_CAPTURE, rawText });

    expect(capture.rawText).toBe(rawText);
  });

  it("carries the normalised text on the event, where downstream reads it", async () => {
    const { ingestion, events } = createHarness();

    await ingestion.ingest({ ...A_TYPED_CAPTURE, rawText: "  Coffee   with\n\nSarah  " });

    const [stored] = await events.readForward(FROM_START);
    expect((stored?.payload as { text: string }).text).toBe("Coffee with Sarah");
  });

  it("records ingested_at separately from source_timestamp", async () => {
    const { ingestion } = createHarness();

    const capture = await ingestion.ingest(A_TYPED_CAPTURE);

    expect(capture.sourceTimestamp).toBe(A_TYPED_CAPTURE.sourceTimestamp);
    expect(capture.ingestedAt).toBe(INGESTED_AT);
  });

  it("leaves corrected text null and records no transcription model for typed input", async () => {
    const { ingestion } = createHarness();

    const capture = await ingestion.ingest(A_TYPED_CAPTURE);

    expect(capture.correctedText).toBeNull();
    expect(capture.transcriptionModel).toBeNull();
  });

  it("records the transcription model for voice input", async () => {
    const { ingestion } = createHarness();

    const capture = await ingestion.ingest({
      ...A_TYPED_CAPTURE,
      source: "voice",
      transcriptionModel: "small.en",
    });

    expect(capture.transcriptionModel).toBe("small.en");
  });

  it("keeps the transcription model off the event payload", async () => {
    // The `captures` column is its one home. A second copy on the event would
    // be a third place the same fact lives, after the row and the model file.
    const { ingestion, events } = createHarness();

    await ingestion.ingest({
      ...A_TYPED_CAPTURE,
      source: "voice",
      transcriptionModel: "small.en",
    });

    const [stored] = await events.readForward(FROM_START);
    expect(JSON.stringify(stored?.payload)).not.toContain("small.en");
  });
});

/**
 * `qa.md` §4.2's durability boundary. The assertion is about ordering, not
 * eventual presence: the Capture must be durable before anything downstream
 * runs, so a failure after that point is resumable and a failure before it
 * loses the user's words.
 */
describe("the durability boundary sits before the event append", () => {
  it("keeps the Capture when the event append fails", async () => {
    connection = openDatabase();
    const captures = new SqliteCaptureStore(connection);
    const events = new SqliteEventStore(connection);
    const failing = {
      ...events,
      append: vi.fn().mockRejectedValue(new Error("the log is unavailable")),
      readForward: events.readForward.bind(events),
      currentVersion: events.currentVersion.bind(events),
    } as unknown as EventStore;
    const ingestion = new CaptureIngestion(
      { captures, events: failing },
      createExecutor(failing),
      () => INGESTED_AT,
    );

    await expect(ingestion.ingest(A_TYPED_CAPTURE)).rejects.toThrow(/log is unavailable/);

    const [survivor] = await captures.withoutIngestionEvent();
    expect(survivor?.rawText).toBe(A_TYPED_CAPTURE.rawText);
  });

  it("surfaces a Capture write failure rather than losing it silently", async () => {
    // Capture is the one path where the user is waiting, and silent loss here
    // is the worst non-log failure in the system (`qa.md` §4.2).
    const { events } = createHarness();
    const refusing: CaptureStore = {
      put: () => Promise.reject(new Error("the disk is full")),
      get: () => Promise.resolve(null),
      recordCorrection: () => Promise.reject(new Error("the disk is full")),
      withoutIngestionEvent: () => Promise.resolve([]),
    };
    const ingestion = new CaptureIngestion(
      { captures: refusing, events },
      createExecutor(events),
      () => INGESTED_AT,
    );

    await expect(ingestion.ingest(A_TYPED_CAPTURE)).rejects.toThrow(/disk is full/);
    expect(await events.readForward(FROM_START)).toHaveLength(0);
  });
});

/** `qa.md` §4.3: double-delivered input produces one Capture. */
describe("re-ingesting the same input produces one Capture and one event", () => {
  it("returns the stored Capture on the second delivery", async () => {
    const { ingestion } = createHarness();

    const first = await ingestion.ingest(A_TYPED_CAPTURE);
    const second = await ingestion.ingest(A_TYPED_CAPTURE);

    expect(second).toEqual(first);
  });

  it("appends one event for two deliveries", async () => {
    const { ingestion, events } = createHarness();

    await ingestion.ingest(A_TYPED_CAPTURE);
    await ingestion.ingest(A_TYPED_CAPTURE);

    expect(await events.readForward(FROM_START)).toHaveLength(1);
  });
});

/**
 * The crash between the two writes, and the sweep that repairs it.
 *
 * The row is written first precisely so this is recoverable: re-running
 * ingestion for the row produces the identical `capture_id` and therefore the
 * identical `eventId`.
 */
describe("the startup sweep recovers a Capture whose event never landed", () => {
  async function crashAfterTheRowIsWritten(captures: CaptureStore): Promise<Capture> {
    return captures.put({
      captureId: "cap-0ee28d5f3077a14b63959caaf2f7415a",
      source: "typed",
      rawText: A_TYPED_CAPTURE.rawText,
      correctedText: null,
      transcriptionModel: null,
      sourceTimestamp: A_TYPED_CAPTURE.sourceTimestamp,
      contentHash: "864aec1c5753d8b92a3910ef9cbcae906422e9cc6b676def8c70dbecda1eba97",
      ingestedAt: INGESTED_AT,
    });
  }

  it("appends exactly one CaptureIngested for the orphaned row", async () => {
    const { recovery, captures, events } = createHarness();
    await crashAfterTheRowIsWritten(captures);

    const recovered = await recovery.recoverUningestedCaptures();

    expect(recovered).toHaveLength(1);
    const log = await events.readForward(FROM_START);
    expect(log).toHaveLength(1);
    expect(log[0]?.type).toBe(CAPTURE_INGESTED);
  });

  /**
   * Two passes in one test, because this is what proves the sweep rides on
   * `deriveEventId` rather than on bookkeeping of its own.
   */
  it("appends nothing on a second pass", async () => {
    const { recovery, captures, events } = createHarness();
    await crashAfterTheRowIsWritten(captures);

    await recovery.recoverUningestedCaptures();
    const secondPass = await recovery.recoverUningestedCaptures();

    expect(secondPass).toEqual([]);
    expect(await events.readForward(FROM_START)).toHaveLength(1);
  });

  it("does nothing when every Capture already has its event", async () => {
    const { ingestion, recovery, events } = createHarness();
    await ingestion.ingest(A_TYPED_CAPTURE);

    expect(await recovery.recoverUningestedCaptures()).toEqual([]);
    expect(await events.readForward(FROM_START)).toHaveLength(1);
  });

  /**
   * Re-emission cannot fork the log even if the normaliser changed between the
   * crash and the sweep, because `deriveEventId` excludes the payload.
   */
  it("produces the same event id as the ingestion that crashed", async () => {
    const { ingestion, recovery, captures, events } = createHarness();
    const capture = await crashAfterTheRowIsWritten(captures);

    await recovery.recoverUningestedCaptures();
    const [fromSweep] = await events.readForward(FROM_START);

    // Re-running ingestion for the same input must collapse onto that event.
    await ingestion.ingest(A_TYPED_CAPTURE);
    const log = await events.readForward(FROM_START);

    expect(log).toHaveLength(1);
    expect(log[0]?.eventId).toBe(fromSweep?.eventId);
    expect(log[0]?.provenance.captureId).toBe(capture.captureId);
  });
});
