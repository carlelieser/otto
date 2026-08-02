import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionWorker } from "../../src/application/projection/projection-worker.js";
import { UpcastRegistry, identityUpcast } from "../../src/domain/events/upcast-registry.js";
import {
  ENTITY_CREATED,
  FIELD_SET,
  KNOWLEDGE_EVENT_TYPES,
  KNOWLEDGE_EVENT_VERSION,
} from "../../src/domain/events/knowledge-events.js";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import { SqliteProjectionStore } from "../../src/infrastructure/persistence/sqlite-projection-store.js";
import { FROM_START, type EventStore } from "../../src/ports/event-store.js";
import type { ProjectionStore } from "../../src/ports/projection-store.js";
import { aFieldSet, anEntityCreated, anEntitiesRelated } from "../support/projection-builders.js";

/** Every knowledge event at its current version, which is what the worker folds. */
function registry(): UpcastRegistry {
  const upcasts = new UpcastRegistry();
  for (const type of KNOWLEDGE_EVENT_TYPES) {
    upcasts.declareCurrentVersion(type, KNOWLEDGE_EVENT_VERSION);
    upcasts.register({ type, fromVersion: KNOWLEDGE_EVENT_VERSION, upcast: identityUpcast });
  }
  return upcasts;
}

let events: EventStore;
let projections: ProjectionStore & { database: ReturnType<typeof openDatabase> };
let worker: ProjectionWorker;

beforeEach(() => {
  const database = openDatabase();
  events = new SqliteEventStore(database);
  const store = new SqliteProjectionStore(database);
  projections = Object.assign(store, { database });
  worker = new ProjectionWorker({ events, projections, upcasts: registry() });
});

describe("catching up with the log", () => {
  it("projects an entity the log created", async () => {
    await events.append([anEntityCreated()]);

    await worker.catchUp();

    const row = projections.database
      .prepare("SELECT * FROM projection_entities WHERE entity_id = ?")
      .get("per-sarah") as { name: string } | undefined;
    expect(row?.name).toBe("Sarah Chen");
  });

  it("records the position it folded to", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);

    await worker.catchUp();

    expect((await projections.checkpoint()).position).toBe(2);
  });

  /** Staleness is the contract (`add.md` §6): the worker lags, it does not block. */
  it("folds only events appended since the last run", async () => {
    await events.append([anEntityCreated()]);
    await worker.catchUp();

    await events.append([aFieldSet({ field: "employer", value: "Acme" })]);
    await worker.catchUp();

    const row = projections.database
      .prepare("SELECT fields FROM projection_entities WHERE entity_id = ?")
      .get("per-sarah") as { fields: string };
    expect(JSON.parse(row.fields)).toMatchObject({ employer: ["Acme"] });
  });

  it("is a no-op when the log has nothing new", async () => {
    await events.append([anEntityCreated()]);
    await worker.catchUp();

    await worker.catchUp();

    expect((await projections.checkpoint()).position).toBe(1);
  });

  it("projects relations", async () => {
    await events.append([anEntitiesRelated()]);

    await worker.catchUp();

    const rows = projections.database.prepare("SELECT * FROM projection_relations").all();
    expect(rows).toHaveLength(1);
  });
});

describe("rebuilding from event zero", () => {
  it("produces the same projection as an incremental run", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);
    await worker.catchUp();
    const incremental = snapshotOf(projections.database);

    await worker.rebuild();

    expect(snapshotOf(projections.database)).toEqual(incremental);
  });

  /** ADR-0005 calls rebuild routine, so a second one must not double anything. */
  it("is byte-identical when run twice", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);

    await worker.rebuild();
    const first = snapshotOf(projections.database);
    await worker.rebuild();

    expect(snapshotOf(projections.database)).toEqual(first);
  });

  it("drops entities the log no longer supports", async () => {
    await events.append([anEntityCreated()]);
    await worker.catchUp();
    projections.database
      .prepare("INSERT INTO projection_entities VALUES ('ghost', 'Person', '{}', 'Ghost', 1)")
      .run();

    await worker.rebuild();

    const ghost = projections.database
      .prepare("SELECT * FROM projection_entities WHERE entity_id = 'ghost'")
      .get();
    expect(ghost).toBeUndefined();
  });

  it("clears the rebuilding flag when it finishes", async () => {
    await events.append([anEntityCreated()]);

    await worker.rebuild();

    expect((await projections.checkpoint()).isRebuilding).toBe(false);
  });
});

describe("a crash mid-rebuild", () => {
  /**
   * `qa.md` §7.1: a crash mid-rebuild must not leave a partially-populated
   * projection presented as complete.
   */
  it("leaves the projection marked as rebuilding", async () => {
    await events.append([anEntityCreated()]);
    await projections.beginRebuild();

    expect((await projections.checkpoint()).isRebuilding).toBe(true);
  });

  it("is recovered by rebuilding again", async () => {
    await events.append([anEntityCreated()]);
    await projections.beginRebuild();

    await worker.rebuild();

    const checkpoint = await projections.checkpoint();
    expect(checkpoint.isRebuilding).toBe(false);
    expect(checkpoint.position).toBe(1);
  });
});

describe("upcasting at read time", () => {
  /**
   * `add.md` §6: upcasting happens at read time in the projection worker, so
   * the log is never migrated. A log of mixed versions must project the same as
   * an all-current one (`qa.md` §4.5).
   */
  it("folds an old-version event through its upcast", async () => {
    const upcasts = new UpcastRegistry();
    upcasts.register({ type: ENTITY_CREATED, fromVersion: 1, upcast: identityUpcast });
    upcasts.register({
      type: FIELD_SET,
      fromVersion: 1,
      upcast: (payload) => ({ ...(payload as object), field: "employer" }),
    });
    upcasts.declareCurrentVersion(FIELD_SET, 2);
    upcasts.register({ type: FIELD_SET, fromVersion: 2, upcast: identityUpcast });
    const versioned = new ProjectionWorker({ events, projections, upcasts });

    await events.append([
      anEntityCreated(),
      { ...aFieldSet({ field: "legacy_employer", value: "Acme" }), version: 1 },
    ]);
    await versioned.catchUp();

    const row = projections.database
      .prepare("SELECT fields FROM projection_entities WHERE entity_id = ?")
      .get("per-sarah") as { fields: string };
    expect(JSON.parse(row.fields)).toMatchObject({ employer: ["Acme"] });
  });

  /** An event whose type has no registered version is folded as it is, not dropped. */
  it("folds an event with no registered upcast unchanged", async () => {
    const empty = new ProjectionWorker({ events, projections, upcasts: new UpcastRegistry() });
    await events.append([anEntityCreated()]);

    await empty.catchUp();

    const row = projections.database
      .prepare("SELECT name FROM projection_entities WHERE entity_id = ?")
      .get("per-sarah") as { name: string } | undefined;
    expect(row?.name).toBe("Sarah Chen");
  });
});

describe("per-field provenance in the projection", () => {
  it("writes a row naming the event that set each field", async () => {
    await events.append([
      anEntityCreated({ eventId: "evt-created" }),
      aFieldSet({ field: "employer", value: "Acme" }, { eventId: "evt-employer" }),
    ]);

    await worker.catchUp();

    const rows = projections.database
      .prepare("SELECT field, event_id FROM projection_field_provenance ORDER BY field")
      .all() as { field: string; event_id: string }[];
    expect(rows).toEqual([
      { field: "employer", event_id: "evt-employer" },
      { field: "name", event_id: "evt-created" },
    ]);
  });

  it("resolves through to the model and confidence", async () => {
    await events.append([anEntityCreated()]);

    await worker.catchUp();

    const row = projections.database
      .prepare("SELECT * FROM projection_field_provenance WHERE field = 'name'")
      .get() as { model_version: string; confidence: number };
    expect(row.model_version).toBe("test-model-1");
    expect(row.confidence).toBe(0.9);
  });

  it("distinguishes a human-confirmed field", async () => {
    await events.append([
      anEntityCreated({ provenance: { isHumanConfirmed: true, confidence: null } }),
    ]);

    await worker.catchUp();

    const row = projections.database
      .prepare("SELECT is_human_confirmed FROM projection_field_provenance WHERE field = 'name'")
      .get() as { is_human_confirmed: number };
    expect(row.is_human_confirmed).toBe(1);
  });
});

describe("resuming from a snapshot", () => {
  /** `qa.md` §7.1: rebuild from a snapshot equals rebuild from event zero. */
  it("equals a rebuild from event zero", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);
    await worker.catchUp();
    const fromCatchUp = snapshotOf(projections.database);

    await worker.rebuild();

    expect(snapshotOf(projections.database)).toEqual(fromCatchUp);
    expect(await events.readForward(FROM_START)).toHaveLength(2);
  });
});

/** Every projection table as plain rows, for comparing two runs. */
function snapshotOf(database: ReturnType<typeof openDatabase>): Record<string, unknown[]> {
  const tables = [
    "projection_entities",
    "projection_aliases",
    "projection_relations",
    "projection_field_provenance",
  ];
  return Object.fromEntries(
    tables.map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all()]),
  );
}
