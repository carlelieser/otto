import { describe, expect, it } from "vitest";
import { createExecutor, createEventStore } from "../../src/composition-root.js";
import { CAPTURE_INGESTED } from "../../src/domain/events/capture-ingested.js";
import { createUpcastRegistry } from "../../src/domain/events/event-versions.js";
import { FROM_START } from "../../src/ports/event-store.js";
import { anIngestCapture } from "../support/builders.js";

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

    expect(stored?.provenance.captureId).toBe("cap-1");
    expect(stored?.provenance.provider).toBe("local");
    expect(stored?.provenance.modelVersion).toBe("qwen2.5-7b-instruct");
  });
});
