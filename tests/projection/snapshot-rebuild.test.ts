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

/** A snapshot whose state is not one, claiming a position it cannot support. */
function aCorruptSnapshot() {
  return {
    projectionName: KNOWLEDGE_PROJECTION,
    position: 2,
    state: "not a snapshot",
    takenAt: "2026-08-02T10:00:00.000Z",
  };
}

/**
 * A worker over the same projections and snapshots, but an empty log.
 *
 * What it rebuilds can only have come from the snapshot, which is what turns
 * "resumed correctly" from a claim into an observation.
 */
function emptyLogWorker(cadence: number): ProjectionWorker {
  return new ProjectionWorker({
    events: new SqliteEventStore(openDatabase()),
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

  /**
   * **`qa.md` §7.1: rebuild from a snapshot equals rebuild from event zero.**
   *
   * The snapshot holds state the log **cannot** reproduce — the events behind
   * it are in a log this worker cannot see. So the resumed entity is present
   * only if `Snapshot.state` was genuinely read back, which is what makes this
   * a test of the resume path rather than of a replay that happens to agree.
   *
   * Two workers over one database, the second with a shorter log, is the same
   * arrangement `rebuild-store.property.test.ts` uses, and for the same reason:
   * `events` refuses DELETE, so presenting fewer events means a different log.
   */
  it("resumes from state the log alone could not produce", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);
    await workerWith(1).rebuild();
    const fromZero = serialiseKnowledge(await projections.read());

    await emptyLogWorker(1).rebuildFromSnapshot();

    expect(serialiseKnowledge(await projections.read())).toBe(fromZero);
  });

  /** Events appended after the snapshot are folded on top of it. */
  it("folds events appended after the snapshot", async () => {
    await events.append([anEntityCreated()]);
    await workerWith(1).rebuild();
    await events.append([aFieldSet({ field: "employer", value: "Acme" })]);

    await workerWith(1).rebuildFromSnapshot();

    const view = await projections.read();
    expect(view.entities.get("per-sarah")?.fields["employer"]).toEqual(["Acme"]);
  });

  /**
   * The resumed projection carries the provenance the snapshot held.
   *
   * Also from a log that cannot reproduce it, so a pointer here proves the
   * snapshot round-tripped rather than that the fold ran again.
   */
  it("carries per-field provenance through the snapshot", async () => {
    await events.append([anEntityCreated({ eventId: "evt-created" })]);
    await workerWith(1).rebuild();

    await emptyLogWorker(1).rebuildFromSnapshot();

    const state = await projections.read();
    expect(state.provenance.get("per-sarah")?.get("name")?.eventId).toBe("evt-created");
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
    await workerWith(1).rebuildFromSnapshot();

    expect(serialiseKnowledge(await projections.read())).toBe(before);
  });

  /**
   * A snapshot that will not deserialise is discarded, and the rebuild proceeds
   * from event zero rather than failing.
   *
   * The corrupt snapshot claims position 2, so resuming from it would fold
   * nothing and leave the projection empty. Arriving at the full state is what
   * shows it replayed instead.
   */
  it("replays from zero when the snapshot is corrupt", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);
    await workerWith(1).rebuild();
    const before = serialiseKnowledge(await projections.read());
    await snapshots.save(aCorruptSnapshot());

    await workerWith(1).rebuildFromSnapshot();

    expect(serialiseKnowledge(await projections.read())).toBe(before);
  });

  /** The corrupt one is discarded rather than left to fail every later rebuild. */
  it("discards a corrupt snapshot", async () => {
    await events.append([anEntityCreated()]);
    await snapshots.save(aCorruptSnapshot());

    // Cadence never, so the fallback rebuild does not write a replacement.
    await workerWith(MVP_SNAPSHOT_POLICY.cadence).rebuildFromSnapshot();

    expect(await snapshots.latest(KNOWLEDGE_PROJECTION)).toBeNull();
  });

  /** `rebuild` ignores any snapshot: it is a replay from event zero by definition. */
  it("replays from zero when rebuild is called directly", async () => {
    await events.append([anEntityCreated()]);
    await workerWith(1).rebuild();

    await workerWith(1).rebuild();

    expect((await projections.checkpoint()).position).toBe(1);
  });
});

describe("rebuilding from a snapshot with none taken", () => {
  /** With the cadence at never there is no snapshot, so this is the ordinary path. */
  it("falls back to a full rebuild", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);

    await workerWith(MVP_SNAPSHOT_POLICY.cadence).rebuildFromSnapshot();

    expect((await projections.checkpoint()).position).toBe(2);
  });

  it("falls back to a full rebuild with no snapshot store at all", async () => {
    await events.append([anEntityCreated()]);
    const worker = new ProjectionWorker({ events, projections, upcasts: new UpcastRegistry() });

    await worker.rebuildFromSnapshot();

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
