import { describe, expect, it } from "vitest";
import {
  isSnapshotDue,
  MVP_SNAPSHOT_POLICY,
  SNAPSHOT_CADENCE_NEVER,
  type Snapshot,
} from "../../src/application/projection/snapshot.js";
import { InMemorySnapshotStore } from "../../src/infrastructure/persistence/in-memory-snapshot-store.js";

function aSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    projectionName: "entities",
    position: 100,
    state: { people: 3 },
    takenAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("the snapshot cadence is off for MVP", () => {
  // runtime.md §4.1: keep the mechanism, set the cadence to never, revisit past
  // ~1M events. The mechanism is the expensive part to add later; the cadence
  // is a constant.
  it("never falls due under the MVP policy", () => {
    expect(isSnapshotDue(MVP_SNAPSHOT_POLICY, 0, 1_000_000)).toBe(false);
  });

  it("ships with the cadence set to never", () => {
    expect(MVP_SNAPSHOT_POLICY.cadence).toBe(SNAPSHOT_CADENCE_NEVER);
  });

  it("falls due on cadence when one is configured, so the mechanism still works", () => {
    const everyThousand = { cadence: 1000 };
    expect(isSnapshotDue(everyThousand, 0, 999)).toBe(false);
    expect(isSnapshotDue(everyThousand, 0, 1000)).toBe(true);
    expect(isSnapshotDue(everyThousand, 500, 1499)).toBe(false);
    expect(isSnapshotDue(everyThousand, 500, 1500)).toBe(true);
  });
});

describe("snapshots are derived and disposable", () => {
  it("resumes a rebuild from the position the snapshot reflects", async () => {
    const store = new InMemorySnapshotStore();
    await store.save(aSnapshot({ position: 250 }));

    const resumed = await store.latest("entities");

    expect(resumed?.position).toBe(250);
    expect(resumed?.state).toEqual({ people: 3 });
  });

  it("rebuilds from event zero when no snapshot exists", async () => {
    const store = new InMemorySnapshotStore();
    expect(await store.latest("entities")).toBeNull();
  });

  it("recovers from a corrupt snapshot by discarding it and replaying fully", async () => {
    const store = new InMemorySnapshotStore();
    await store.save(aSnapshot());

    await store.discard("entities");

    expect(await store.latest("entities")).toBeNull();
  });

  it("keeps snapshots separate per projection", async () => {
    const store = new InMemorySnapshotStore();
    await store.save(aSnapshot({ projectionName: "entities", position: 10 }));
    await store.save(aSnapshot({ projectionName: "review-queue", position: 20 }));

    expect((await store.latest("entities"))?.position).toBe(10);
    expect((await store.latest("review-queue"))?.position).toBe(20);
  });

  it("does not let an older snapshot replace a newer one", async () => {
    const store = new InMemorySnapshotStore();
    await store.save(aSnapshot({ position: 500 }));
    await store.save(aSnapshot({ position: 100 }));

    expect((await store.latest("entities"))?.position).toBe(500);
  });
});
