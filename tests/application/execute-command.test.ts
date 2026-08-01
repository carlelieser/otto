import { describe, expect, it } from "vitest";
import { createExecutor, createEventStore } from "../../src/composition-root.js";
import { deriveEventId } from "../../src/application/pipeline/event-identity.js";
import { CAPTURE_INGESTED } from "../../src/domain/events/capture-ingested.js";
import {
  StaleCommandError,
  UnknownCommandError,
} from "../../src/application/pipeline/execute-command.js";
import { FROM_START, type EventStore } from "../../src/ports/event-store.js";
import { anIngestCapture } from "../support/builders.js";

const FIXED_NOW = "2026-08-01T09:00:01.000Z";
const executorFor = (store: EventStore) => createExecutor(store, () => FIXED_NOW);

describe("the executor appends and returns", () => {
  it("appends the event a Command implies", async () => {
    const store = createEventStore();
    const stored = await executorFor(store).execute(anIngestCapture());

    expect(stored.type).toBe(CAPTURE_INGESTED);
    expect(stored.version).toBe(1);
    expect(stored.recordedAt).toBe(FIXED_NOW);
  });

  it("carries the Command's provenance onto the event", async () => {
    const store = createEventStore();
    const command = anIngestCapture();

    const stored = await executorFor(store).execute(command);

    expect(stored.provenance).toEqual(command.provenance);
  });

  it("stamps the aggregate version the Command was computed against", async () => {
    const store = createEventStore();
    const stored = await executorFor(store).execute(anIngestCapture());

    expect(stored.aggregate).toEqual({ type: "Capture", id: "cap-1", version: 0 });
  });

  it("writes only to the log, and the log holds exactly what it returned", async () => {
    const store = createEventStore();
    const stored = await executorFor(store).execute(anIngestCapture());

    expect(await store.readForward(FROM_START)).toEqual([stored]);
  });

  it("refuses a Command it has no translator for", async () => {
    const store = createEventStore();
    const unknown = anIngestCapture({ type: "DemolishEverything" });

    await expect(executorFor(store).execute(unknown)).rejects.toThrow(UnknownCommandError);
  });
});

describe("optimistic concurrency on the aggregate version", () => {
  // add.md §5.6: the staleness *behaviour* is Slice 4's, but the version stamp
  // and its check have to be on the event from the first one.
  it("refuses a Command computed against a stale version", async () => {
    const store = createEventStore();
    const executor = executorFor(store);
    await executor.execute(anIngestCapture());

    const stale = anIngestCapture({
      aggregate: { type: "Capture", id: "cap-1", expectedVersion: 0 },
    });

    await expect(executor.execute(stale)).rejects.toThrow(StaleCommandError);
  });

  it("names the aggregate and both versions when it refuses", async () => {
    const store = createEventStore();
    const executor = executorFor(store);
    await executor.execute(anIngestCapture());
    const stale = anIngestCapture({
      aggregate: { type: "Capture", id: "cap-1", expectedVersion: 0 },
    });

    await expect(executor.execute(stale)).rejects.toThrow(/cap-1.*expected version 0.*found 1/);
  });

  it("accepts a Command computed against the current version", async () => {
    const store = createEventStore();
    const executor = executorFor(store);
    await executor.execute(anIngestCapture());

    const next = anIngestCapture({
      aggregate: { type: "Capture", id: "cap-1", expectedVersion: 1 },
      provenance: { ...anIngestCapture().provenance, proposalId: "prop-2" },
    });

    await expect(executor.execute(next)).resolves.toMatchObject({ version: 1 });
  });

  it("appends nothing when it refuses a stale Command", async () => {
    const store = createEventStore();
    const executor = executorFor(store);
    await executor.execute(anIngestCapture());
    const stale = anIngestCapture({
      aggregate: { type: "Capture", id: "cap-1", expectedVersion: 0 },
    });

    await executor.execute(stale).catch(() => undefined);

    expect(await store.readForward(FROM_START)).toHaveLength(1);
  });
});

describe("event ids are derived, not minted", () => {
  // The idempotency substrate Slice 1 builds on (`runtime.md` §3). Asserted on
  // the derivation directly: replaying a Command through the executor trips the
  // stale check first, so it would not exercise this.
  it("derives the same id for the same Command", () => {
    expect(deriveEventId(anIngestCapture())).toBe(deriveEventId(anIngestCapture()));
  });

  it("derives a different id under a different model version", () => {
    // A better model should be able to say something new about an old Capture;
    // an id derived from the Capture alone would silently prevent that.
    const command = anIngestCapture();
    const reExtracted = anIngestCapture({
      provenance: { ...command.provenance, modelVersion: "qwen3-14b-instruct" },
    });

    expect(deriveEventId(reExtracted)).not.toBe(deriveEventId(command));
  });

  it("derives a different id for a different Capture", () => {
    const command = anIngestCapture();
    const otherCapture = anIngestCapture({
      provenance: { ...command.provenance, captureId: "cap-2" },
    });

    expect(deriveEventId(otherCapture)).not.toBe(deriveEventId(command));
  });

  it("appends one event when the derived id is already in the log", async () => {
    // The executor stamps the id; the store refuses the duplicate.
    const store = createEventStore();
    const stored = await executorFor(store).execute(anIngestCapture());

    await store.append([stored]);

    expect(await store.readForward(FROM_START)).toHaveLength(1);
  });
});
