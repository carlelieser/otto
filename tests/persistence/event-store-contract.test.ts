import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import { FROM_START, type EventStore } from "../../src/ports/event-store.js";
import { aCaptureIngested } from "../support/builders.js";

const createStore = (): EventStore => new SqliteEventStore();

/**
 * What an EventStore does, asserted against the adapter that ships: SQLite in
 * its `:memory:` mode. Append and read forward are the whole surface — there is
 * no update and no delete, and that absence is the point (`add.md` §10).
 */
describe("the EventStore contract", () => {
  it("appends an event and reads it back", async () => {
    const store = createStore();
    const event = aCaptureIngested();

    await store.append([event]);
    const [stored] = await store.readForward(FROM_START);

    expect(stored).toMatchObject({
      eventId: event.eventId,
      type: event.type,
      version: event.version,
      payload: event.payload,
      provenance: event.provenance,
    });
  });

  it("assigns increasing positions in append order", async () => {
    const store = createStore();
    await store.append([aCaptureIngested({ eventId: "evt-1" })]);
    await store.append([aCaptureIngested({ eventId: "evt-2" })]);

    const stored = await store.readForward(FROM_START);

    expect(stored.map((event) => event.eventId)).toEqual(["evt-1", "evt-2"]);
    expect(stored[0]!.position).toBeLessThan(stored[1]!.position);
  });

  it("reads forward from a position, exclusive", async () => {
    const store = createStore();
    const [first] = await store.append([aCaptureIngested({ eventId: "evt-1" })]);
    await store.append([aCaptureIngested({ eventId: "evt-2" })]);

    const after = await store.readForward(first!.position);

    expect(after.map((event) => event.eventId)).toEqual(["evt-2"]);
  });

  it("limits how many events it reads forward", async () => {
    const store = createStore();
    await store.append([
      aCaptureIngested({ eventId: "evt-1" }),
      aCaptureIngested({ eventId: "evt-2" }),
      aCaptureIngested({ eventId: "evt-3" }),
    ]);

    const limited = await store.readForward(FROM_START, 2);

    expect(limited.map((event) => event.eventId)).toEqual(["evt-1", "evt-2"]);
  });

  it("preserves provenance through a round trip", async () => {
    const store = createStore();
    const event = aCaptureIngested();

    await store.append([event]);
    const [stored] = await store.readForward(FROM_START);

    expect(stored!.provenance).toEqual(event.provenance);
  });

  it("reports an aggregate's current version", async () => {
    const store = createStore();
    const aggregate = { type: "Capture", id: "cap-7", version: 0 };
    await store.append([aCaptureIngested({ eventId: "evt-1", aggregate })]);

    expect(await store.currentVersion("cap-7")).toBe(1);
  });

  it("reports version 0 for an aggregate with no events", async () => {
    const store = createStore();
    expect(await store.currentVersion("never-seen")).toBe(0);
  });

  it("appending the same event twice produces one event, not two", async () => {
    // The idempotency substrate Slice 1 builds on (`runtime.md` §3).
    const store = createStore();
    const event = aCaptureIngested();

    await store.append([event]);
    await store.append([event]);

    expect(await store.readForward(FROM_START)).toHaveLength(1);
  });

  it("rejects an event with incomplete provenance", async () => {
    // qa.md §4.4: a missing provenance field is a Tier 0 failure.
    const store = createStore();
    const event = aCaptureIngested({
      provenance: { ...aCaptureIngested().provenance, captureId: "" },
    });

    await expect(store.append([event])).rejects.toThrow(/provenance\.captureId/);
  });

  it("rejects a whitespace-only event id, not just an empty one", async () => {
    const store = createStore();
    await expect(store.append([aCaptureIngested({ eventId: "   " })])).rejects.toThrow(/eventId/);
  });

  it("rejects an event before storing any of the batch", async () => {
    const store = createStore();
    const valid = aCaptureIngested({ eventId: "evt-valid" });
    const invalid = aCaptureIngested({ eventId: "" });

    await expect(store.append([valid, invalid])).rejects.toThrow();
    expect(await store.readForward(FROM_START)).toEqual([]);
  });

  describe("has no UPDATE or DELETE path at the repository level", () => {
    // qa.md §4.1 asks for this independently of the SQLite-level assertion.
    // The port cannot express mutation, so the assertion is about absence:
    // no method exists to reach for, and a returned event is a copy that
    // cannot be edited back into the log.
    const MUTATING_NAMES = ["update", "delete", "remove", "replace", "edit", "truncate"];

    it("exposes no mutating method", async () => {
      const store = createStore();
      const available = surfaceOf(store);

      const mutators = available.filter((name) =>
        MUTATING_NAMES.some((forbidden) => name.toLowerCase().includes(forbidden)),
      );

      expect(mutators).toEqual([]);
    });

    it("exposes nothing beyond the port and connection lifecycle", async () => {
      // `close` is lifecycle rather than a way to change the log, so it is
      // the one addition an adapter may carry.
      const store = createStore();
      const beyondThePort = surfaceOf(store).filter(
        (name) => !["append", "readForward", "currentVersion"].includes(name),
      );

      expect(beyondThePort.filter((name) => name !== "close")).toEqual([]);
    });

    it("does not let a caller edit the log by mutating what it read back", async () => {
      // qa.md §4.4: an attempted in-place payload edit fails at the storage
      // layer. Each read rebuilds events from rows, so what a caller holds is a
      // copy and editing it reaches nothing.
      const store = createStore();
      await store.append([aCaptureIngested()]);

      const [read] = await store.readForward(FROM_START);
      (read as { payload: unknown }).payload = { tampered: true };

      const [reread] = await store.readForward(FROM_START);
      expect(reread!.payload).not.toEqual({ tampered: true });
      expect(reread!.payload).toEqual(aCaptureIngested().payload);
    });
  });
});

/** The store's callable public surface, excluding the constructor. */
function surfaceOf(store: EventStore): string[] {
  const own = Object.getOwnPropertyNames(store);
  const inherited = Object.getOwnPropertyNames(Object.getPrototypeOf(store) as object);
  return [...new Set([...own, ...inherited])].filter(
    (name) => name !== "constructor" && typeof (store as never)[name] === "function",
  );
}
