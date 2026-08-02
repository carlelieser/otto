import { describe, expect, it } from "vitest";
import { createExecutor, createEventStore } from "../../src/composition-root.js";
import { CAPTURE_INGESTED } from "../../src/domain/events/capture-ingested.js";
import { createUpcastRegistry } from "../../src/domain/events/event-versions.js";
import { FROM_START } from "../../src/ports/event-store.js";
import { anIngestCapture, A_CAPTURE_ID } from "../support/builders.js";

/**
 * The whole write path end to end: a Command in, an event on the log, read
 * back through the upcast seam a projection will use.
 *
 * The store is SQLite against `:memory:` — the production adapter in the mode
 * that needs no disk, rather than a second implementation standing in for it.
 */
describe("the write path, end to end", () => {
  it("takes a Command through the executor to a readable event", async () => {
    const store = createEventStore();
    const executor = createExecutor(store, () => "2026-08-01T09:00:01.000Z");

    await executor.execute(anIngestCapture());
    const [stored] = await store.readForward(FROM_START);

    expect(stored?.type).toBe(CAPTURE_INGESTED);
    expect(stored?.payload).toEqual(anIngestCapture().payload);
  });

  it("reads the appended event back through the upcast registry", async () => {
    // Upcasting happens at read time (ADR-0011), so the read path a projection
    // will use is exercised here even though projections are Slice 5.
    const store = createEventStore();
    const executor = createExecutor(store);
    const registry = createUpcastRegistry();

    await executor.execute(anIngestCapture());
    const [stored] = await store.readForward(FROM_START);

    expect(registry.upcastToCurrent(stored!).payload).toEqual(anIngestCapture().payload);
  });

  it("names the Capture the event came from, so provenance survives the round trip", async () => {
    const store = createEventStore();
    const executor = createExecutor(store);

    await executor.execute(anIngestCapture());
    const [stored] = await store.readForward(FROM_START);

    expect(stored?.provenance.captureId).toBe(A_CAPTURE_ID);
  });

  /**
   * Ingestion has no model to name, so both provenance fields are `"human"`.
   *
   * Naming the transcriber here is the tempting answer and the wrong one:
   * `provider` and `modelVersion` are the key `triage.md` §2 uses for
   * thresholds and §4 uses to count Corrections toward bootstrap exit, and a
   * transcriber never proposes anything and has no Confidence to calibrate. A
   * `whisper.cpp` cohort would be a bootstrap bucket that can never fill.
   */
  it("records ingestion as human-confirmed, because no inference happened", async () => {
    const store = createEventStore();
    const executor = createExecutor(store);

    await executor.execute(anIngestCapture());
    const [stored] = await store.readForward(FROM_START);

    expect(stored?.provenance.provider).toBe("human");
    expect(stored?.provenance.modelVersion).toBe("human");
    expect(stored?.provenance.confidence).toBeNull();
    expect(stored?.provenance.proposalId).toBeNull();
  });

  /**
   * `isHumanConfirmed` does not assert the transcript is accurate; it asserts
   * that nothing unattended decided anything. A misheard name is a wrong
   * Capture, not an unconfirmed one — which is why correction is its own event
   * in Slice 9 rather than a Confidence here.
   */
  it("marks the Capture human-confirmed, since no inference stands between user and Capture", async () => {
    const store = createEventStore();
    const executor = createExecutor(store);

    await executor.execute(anIngestCapture());
    const [stored] = await store.readForward(FROM_START);

    expect(stored?.provenance.isHumanConfirmed).toBe(true);
  });
});
