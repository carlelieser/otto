import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionWorker } from "../../src/application/projection/projection-worker.js";
import { KnowledgeReads } from "../../src/application/surface/read-knowledge.js";
import { UpcastRegistry } from "../../src/domain/events/upcast-registry.js";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteEntityViewStore } from "../../src/infrastructure/persistence/sqlite-entity-view-store.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import { SqliteProjectionStore } from "../../src/infrastructure/persistence/sqlite-projection-store.js";
import type { EventStore } from "../../src/ports/event-store.js";
import type { ProjectionStore } from "../../src/ports/projection-store.js";
import { aFieldSet, anEntityCreated } from "../support/projection-builders.js";

let events: EventStore;
let projections: ProjectionStore;
let reads: KnowledgeReads;
let worker: ProjectionWorker;

beforeEach(() => {
  const database = openDatabase();
  events = new SqliteEventStore(database);
  projections = new SqliteProjectionStore(database);
  reads = new KnowledgeReads(new SqliteEntityViewStore(database), projections);
  worker = new ProjectionWorker({ events, projections, upcasts: new UpcastRegistry() });
});

describe("reading an entity through the surface", () => {
  it("returns the view with its provenance", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);
    await worker.catchUp();

    const { data } = await reads.entityView("per-sarah");

    expect(data?.entity.fields["employer"]).toEqual(["Acme"]);
    expect(data?.provenance.get("employer")).toBeDefined();
  });

  /** `add.md` §6: every read surface tolerates staleness rather than blocking. */
  it("reports how far the projection has folded", async () => {
    await events.append([anEntityCreated()]);
    await worker.catchUp();

    const { freshness } = await reads.entityView("per-sarah");

    expect(freshness.position).toBe(1);
    expect(freshness.isRebuilding).toBe(false);
  });

  /**
   * `qa.md` §9: a missing projection is handled gracefully rather than erroring
   * at the UI, and the freshness is what tells a caller which kind of miss it is.
   */
  it("returns no data and a zero position when nothing is projected", async () => {
    await events.append([anEntityCreated()]);

    const { data, freshness } = await reads.entityView("per-sarah");

    expect(data).toBeUndefined();
    expect(freshness.position).toBe(0);
  });

  it("reports a rebuild in flight", async () => {
    await events.append([anEntityCreated()]);
    await projections.beginRebuild();

    const { freshness } = await reads.entityView("per-sarah");

    expect(freshness.isRebuilding).toBe(true);
  });
});

describe("the other reads on the surface", () => {
  it("lists entities of a type", async () => {
    await events.append([anEntityCreated()]);
    await worker.catchUp();

    const { data } = await reads.entitiesOfType("Person");

    expect(data).toHaveLength(1);
  });

  it("searches entities", async () => {
    await events.append([anEntityCreated()]);
    await worker.catchUp();

    const { data } = await reads.searchEntities("Sarah");

    expect(data).toEqual([{ entityId: "per-sarah", entityType: "Person" }]);
  });

  it("searches Captures", async () => {
    const { data } = await reads.searchCaptures("Sarah");

    expect(data).toEqual([]);
  });
});
