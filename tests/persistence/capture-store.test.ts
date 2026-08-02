import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteCaptureStore } from "../../src/infrastructure/persistence/sqlite-capture-store.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import type { Capture, CaptureStore } from "../../src/ports/capture-store.js";
import { aCapture, aCaptureIngested } from "../support/builders.js";

let connection: Database.Database | undefined;

afterEach(() => {
  connection?.close();
  connection = undefined;
});

function createStores(): { captures: CaptureStore; events: SqliteEventStore } {
  connection = openDatabase();
  return { captures: new SqliteCaptureStore(connection), events: new SqliteEventStore(connection) };
}

describe("CaptureStore round-trips a Capture", () => {
  it("returns the Capture it stored", async () => {
    const { captures } = createStores();
    const capture = aCapture();

    expect(await captures.put(capture)).toEqual(capture);
    expect(await captures.get(capture.captureId)).toEqual(capture);
  });

  it("returns null for a Capture that was never stored", async () => {
    const { captures } = createStores();
    expect(await captures.get("cap-nothing-here")).toBeNull();
  });

  it("keeps raw text exactly as it arrived, whitespace and all", async () => {
    // `content_hash` is computed over this column, so anything that trims or
    // collapses it here changes every id in the system.
    const { captures } = createStores();
    const rawText = "  Coffee   with\n\nSarah  ";

    const stored = await captures.put(aCapture({ rawText }));

    expect(stored.rawText).toBe(rawText);
  });

  it("stores a voice Capture's transcription model and a typed one's null", async () => {
    const { captures } = createStores();

    const voice = await captures.put(
      aCapture({ captureId: "cap-voice", source: "voice", transcriptionModel: "small.en" }),
    );
    const typed = await captures.put(aCapture({ captureId: "cap-typed", source: "typed" }));

    expect(voice.transcriptionModel).toBe("small.en");
    expect(typed.transcriptionModel).toBeNull();
  });

  it("leaves corrected text null, which is Slice 9's field to write", async () => {
    const { captures } = createStores();
    expect((await captures.put(aCapture())).correctedText).toBeNull();
  });
});

/**
 * `qa.md` §4.3: double-delivered input produces one Capture. The store makes
 * this a property of storage rather than a rule every call site remembers.
 */
describe("CaptureStore collapses a double delivery", () => {
  it("returns the stored Capture rather than throwing on a second insert", async () => {
    const { captures } = createStores();
    const capture = aCapture();

    const first = await captures.put(capture);
    const second = await captures.put(capture);

    expect(second).toEqual(first);
  });

  it("does not overwrite the stored Capture with the second delivery", async () => {
    // A no-op, not a silent overwrite: what comes back is what was stored
    // first, even when the second delivery differs in a field outside the id.
    const { captures } = createStores();
    const original = aCapture({ transcriptionModel: "small.en" });
    await captures.put(original);

    const redelivered = await captures.put({ ...original, transcriptionModel: "large-v3" });

    expect(redelivered.transcriptionModel).toBe("small.en");
  });

  it("stores one row for two deliveries", async () => {
    const { captures } = createStores();
    const capture = aCapture();

    await captures.put(capture);
    await captures.put(capture);

    const { count } = connection!.prepare(`SELECT COUNT(*) AS count FROM captures`).get() as {
      count: number;
    };
    expect(count).toBe(1);
  });
});

/**
 * The repository-level half of `qa.md` §4.1's pair. The database-level half is
 * in `sqlite-event-store.test.ts`, and both are required: a test that the
 * application declines to do something is weaker than a database that will not
 * permit it, and a database constraint says nothing about what the port offers.
 */
describe("CaptureStore has no update or delete path", () => {
  it("offers no method that mutates or removes a stored Capture", () => {
    const { captures } = createStores();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(captures));

    expect(surface).not.toContain("update");
    expect(surface).not.toContain("delete");
    expect(surface.filter((name) => /update|delete|remove|edit|set/i.test(name))).toEqual([]);
  });
});

describe("CaptureStore finds Captures the log does not mention", () => {
  it("returns a Capture whose event never landed", async () => {
    // The crash between the two writes: the row is there, the event is not.
    const { captures } = createStores();
    const capture = await captures.put(aCapture());

    expect(await captures.withoutIngestionEvent()).toEqual([capture]);
  });

  it("excludes a Capture whose CaptureIngested is in the log", async () => {
    const { captures, events } = createStores();
    const capture = await captures.put(aCapture());
    await events.append([aCaptureIngested({ provenance: provenanceFor(capture) })]);

    expect(await captures.withoutIngestionEvent()).toEqual([]);
  });

  /**
   * The filter that stops being redundant in Slice 9. A Capture with some other
   * event but no ingestion event is still unrecovered, and an unfiltered
   * anti-join would call it recovered.
   */
  it("still returns a Capture carrying a different event type", async () => {
    const { captures, events } = createStores();
    const capture = await captures.put(aCapture());
    await events.append([
      aCaptureIngested({
        eventId: "evt-corrected",
        type: "CaptureTranscriptCorrected",
        provenance: provenanceFor(capture),
      }),
    ]);

    expect(await captures.withoutIngestionEvent()).toEqual([capture]);
  });

  it("returns nothing when every Capture has its event", async () => {
    const { captures } = createStores();
    expect(await captures.withoutIngestionEvent()).toEqual([]);
  });

  it("returns unrecovered Captures oldest first", async () => {
    const { captures } = createStores();
    const older = await captures.put(
      aCapture({ captureId: "cap-older", ingestedAt: "2026-08-01T09:00:00.000Z" }),
    );
    const newer = await captures.put(
      aCapture({ captureId: "cap-newer", ingestedAt: "2026-08-01T09:00:01.000Z" }),
    );

    expect(await captures.withoutIngestionEvent()).toEqual([older, newer]);
  });
});

function provenanceFor(capture: Capture) {
  return {
    proposalId: null,
    captureId: capture.captureId,
    provider: "human",
    modelVersion: "human",
    confidence: null,
    isHumanConfirmed: true,
  };
}
