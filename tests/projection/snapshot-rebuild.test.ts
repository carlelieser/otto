import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionWorker } from "../../src/application/projection/projection-worker.js";
import {
  MVP_SNAPSHOT_POLICY,
  type SnapshotStore,
} from "../../src/application/projection/snapshot.js";
import { KNOWLEDGE_PROJECTION } from "../../src/ports/projection-store.js";
import { UpcastRegistry } from "../../src/domain/events/upcast-registry.js";
import { serialiseKnowledge } from "../../src/domain/knowledge/serialise-knowledge.js";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { InMemorySnapshotStore } from "../../src/infrastructure/persistence/in-memory-snapshot-store.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import { SqliteProjectionStore } from "../../src/infrastructure/persistence/sqlite-projection-store.js";
import type { EventStore } from "../../src/ports/event-store.js";
import { aFieldSet, anEntityCreated } from "../support/projection-builders.js";

let events: EventStore;
let projections: SqliteProjectionStore;
let snapshots: SnapshotStore;

/** A worker with snapshots wired in, at whatever cadence a test is about. */
function workerWith(cadence: number): ProjectionWorker {
  return new ProjectionWorker({
    events,
    projections,
    upcasts: new UpcastRegistry(),
    snapshots,
    snapshotPolicy: { cadence },
  });
}

beforeEach(() => {
  const database = openDatabase();
  events = new SqliteEventStore(database);
  projections = new SqliteProjectionStore(database);
  snapshots = new InMemorySnapshotStore();
});

describe("the snapshot cadence in production", () => {
  /**
   * `runtime.md` §4.1: keep the mechanism, set the cadence to never. Full
   * rebuild is 215 ms at the specified corpus, so there is nothing to tune yet.
   */
  it("writes no snapshot under the MVP policy", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);
    const worker = workerWith(MVP_SNAPSHOT_POLICY.cadence);

    await worker.rebuild();

    expect(await snapshots.latest(KNOWLEDGE_PROJECTION)).toBeNull();
  });
});

describe("the snapshot mechanism, with a cadence configured", () => {
  /** The mechanism is kept because it is the expensive part to add later. */
  it("writes a snapshot once the cadence is passed", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);

    await workerWith(1).rebuild();

    expect((await snapshots.latest(KNOWLEDGE_PROJECTION))?.position).toBe(2);
  });

  /** `qa.md` §7.1: rebuild from a snapshot equals rebuild from event zero. */
  it("resumes from a snapshot to the same state as a full rebuild", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);
    await workerWith(1).rebuild();
    const fromZero = serialiseKnowledge(await projections.read());

    await events.append([aFieldSet({ field: "role", value: "Engineer" })]);
    await workerWith(1).catchUp();
    const resumed = serialiseKnowledge(await projections.read());

    await workerWith(1).rebuild();
    expect(serialiseKnowledge(await projections.read())).toBe(resumed);
    expect(resumed).not.toBe(fromZero);
  });

  /**
   * `qa.md` §7.1: a corrupt or stale snapshot is recoverable by deleting it and
   * replaying fully. Snapshots are derived, so discarding one costs a replay
   * and never data.
   */
  it("rebuilds fully after its snapshot is discarded", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);
    await workerWith(1).rebuild();
    const before = serialiseKnowledge(await projections.read());

    await snapshots.discard(KNOWLEDGE_PROJECTION);
    await workerWith(1).rebuild();

    expect(serialiseKnowledge(await projections.read())).toBe(before);
  });

  /** A rebuild ignores any snapshot: it is a replay from event zero by definition. */
  it("replays from zero even when a snapshot exists", async () => {
    await events.append([anEntityCreated()]);
    await workerWith(1).rebuild();

    await workerWith(1).rebuild();

    expect((await projections.checkpoint()).position).toBe(1);
  });
});

describe("a worker with no snapshot store", () => {
  /** Snapshots are optional machinery; a worker without one still folds. */
  it("projects normally", async () => {
    await events.append([anEntityCreated()]);
    const worker = new ProjectionWorker({ events, projections, upcasts: new UpcastRegistry() });

    await worker.rebuild();

    expect((await projections.checkpoint()).position).toBe(1);
  });
});
