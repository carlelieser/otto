import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionWorker } from "../../src/application/projection/projection-worker.js";
import { UpcastRegistry } from "../../src/domain/events/upcast-registry.js";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteCaptureStore } from "../../src/infrastructure/persistence/sqlite-capture-store.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import { SqliteEntityViewStore } from "../../src/infrastructure/persistence/sqlite-entity-view-store.js";
import { SqliteProjectionStore } from "../../src/infrastructure/persistence/sqlite-projection-store.js";
import type { EventStore } from "../../src/ports/event-store.js";
import {
  aFieldSet,
  aSetMemberAdded,
  anEntitiesRelated,
  anEntityCreated,
} from "../support/projection-builders.js";

let events: EventStore;
let views: SqliteEntityViewStore;
let captures: SqliteCaptureStore;
let projections: SqliteProjectionStore;
let worker: ProjectionWorker;

beforeEach(() => {
  const database = openDatabase();
  events = new SqliteEventStore(database);
  captures = new SqliteCaptureStore(database);
  views = new SqliteEntityViewStore(database);
  projections = new SqliteProjectionStore(database);
  worker = new ProjectionWorker({ events, projections, upcasts: new UpcastRegistry() });
});

describe("the entity view", () => {
  it("returns the entity with its fields", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);
    await worker.catchUp();

    const view = await views.entityView("per-sarah");

    expect(view?.entity.fields).toMatchObject({ name: ["Sarah Chen"], employer: ["Acme"] });
  });

  /** `add.md` §7: the Person view is a row and a handful of joins. */
  it("returns the relations at either end of the entity", async () => {
    await events.append([anEntityCreated(), anEntitiesRelated()]);
    await worker.catchUp();

    const view = await views.entityView("per-sarah");

    expect(view?.relations).toEqual([
      {
        name: "involves",
        from: { id: "proj-helios", type: "Project" },
        to: { id: "per-sarah", type: "Person" },
      },
    ]);
  });

  it("names the event that last set each field", async () => {
    await events.append([
      anEntityCreated({ eventId: "evt-created" }),
      aFieldSet({ field: "employer", value: "Acme" }, { eventId: "evt-employer" }),
    ]);
    await worker.catchUp();

    const view = await views.entityView("per-sarah");

    expect(view?.provenance.get("employer")?.eventId).toBe("evt-employer");
    expect(view?.provenance.get("name")?.eventId).toBe("evt-created");
  });

  /** The pointer resolves through to the model and the confidence at the time. */
  it("resolves a field's provenance through to model and confidence", async () => {
    await events.append([anEntityCreated()]);
    await worker.catchUp();

    const view = await views.entityView("per-sarah");

    const pointer = view?.provenance.get("name");
    expect(pointer?.provenance.modelVersion).toBe("test-model-1");
    expect(pointer?.provenance.confidence).toBe(0.9);
    expect(pointer?.provenance.captureId).toBe("cap-1");
  });

  it("distinguishes a human-confirmed field from an auto-applied one", async () => {
    await events.append([
      anEntityCreated({ eventId: "evt-a" }),
      aFieldSet(
        { field: "employer", value: "Acme" },
        { eventId: "evt-b", provenance: { isHumanConfirmed: true, confidence: null } },
      ),
    ]);
    await worker.catchUp();

    const view = await views.entityView("per-sarah");

    expect(view?.provenance.get("name")?.provenance.isHumanConfirmed).toBe(false);
    expect(view?.provenance.get("employer")?.provenance.isHumanConfirmed).toBe(true);
  });

  /**
   * `qa.md` §9: the application handles a missing projection gracefully rather
   * than erroring at the UI. An unprojected entity is absent, not an exception.
   */
  it("returns undefined for an entity the projection does not hold", async () => {
    expect(await views.entityView("per-nobody")).toBeUndefined();
  });

  it("returns undefined before the worker has caught up", async () => {
    await events.append([anEntityCreated()]);

    expect(await views.entityView("per-sarah")).toBeUndefined();
  });
});

describe("listing entities of a type", () => {
  it("returns them ordered by name", async () => {
    await events.append([
      anEntityCreated({ aggregateId: "per-1", payload: { name: "Zoe" } }),
      anEntityCreated({ aggregateId: "per-2", payload: { name: "Adam" } }),
    ]);
    await worker.catchUp();

    const people = await views.entitiesOfType("Person");

    expect(people.map((person) => person.fields["name"]?.[0])).toEqual(["Adam", "Zoe"]);
  });

  it("returns none for a type with no entities", async () => {
    expect(await views.entitiesOfType("Task")).toEqual([]);
  });
});

describe("full-text search over entities", () => {
  it("finds an entity by a word in one of its fields", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);
    await worker.catchUp();

    const hits = await views.searchEntities("Acme");

    expect(hits).toEqual([{ entityId: "per-sarah", entityType: "Person" }]);
  });

  it("finds an entity by its name", async () => {
    await events.append([anEntityCreated()]);
    await worker.catchUp();

    expect(await views.searchEntities("Sarah")).toHaveLength(1);
  });

  it("finds an entity by an alias", async () => {
    await events.append([
      anEntityCreated(),
      aSetMemberAdded({ field: "aliases", value: "Sarah C" }),
    ]);
    await worker.catchUp();

    expect(await views.searchEntities("Sarah C")).toHaveLength(1);
  });

  it("returns nothing for a term no entity holds", async () => {
    await events.append([anEntityCreated()]);
    await worker.catchUp();

    expect(await views.searchEntities("Globex")).toEqual([]);
  });

  /**
   * A search index that outlives the fact it indexed would return a hit for a
   * value the entity no longer has.
   */
  it("stops returning a superseded value", async () => {
    await events.append([anEntityCreated(), aFieldSet({ field: "employer", value: "Acme" })]);
    await worker.catchUp();
    await events.append([aFieldSet({ field: "employer", value: "Globex" })]);
    await worker.catchUp();

    expect(await views.searchEntities("Acme")).toEqual([]);
    expect(await views.searchEntities("Globex")).toHaveLength(1);
  });

  /** A query is user input, so FTS5 syntax in it must not be a syntax error. */
  it("treats punctuation in a query as text rather than syntax", async () => {
    await events.append([anEntityCreated()]);
    await worker.catchUp();

    await expect(views.searchEntities('Sarah" OR x:')).resolves.toEqual([]);
  });

  it("returns nothing for an empty query", async () => {
    await events.append([anEntityCreated()]);
    await worker.catchUp();

    expect(await views.searchEntities("   ")).toEqual([]);
  });
});

describe("full-text search over Captures", () => {
  it("finds a Capture by a word in its text", async () => {
    await captures.put(aCapture("cap-1", "Coffee with Sarah about Helios"));
    await projections.reindexCaptures();

    const hits = await views.searchCaptures("Helios");

    expect(hits).toEqual([{ captureId: "cap-1", text: "Coffee with Sarah about Helios" }]);
  });

  it("returns nothing for a term no Capture holds", async () => {
    await captures.put(aCapture("cap-1", "Coffee with Sarah"));
    await projections.reindexCaptures();

    expect(await views.searchCaptures("Globex")).toEqual([]);
  });

  /** Indexing twice must not return one Capture twice. */
  it("indexes a Capture once however often it is reindexed", async () => {
    await captures.put(aCapture("cap-1", "Coffee with Sarah"));
    await projections.reindexCaptures();
    await projections.reindexCaptures();

    expect(await views.searchCaptures("Sarah")).toHaveLength(1);
  });

  /**
   * A rebuild must put the Capture index back.
   *
   * `reset` empties it and no event carries a Capture's text, so a rebuild that
   * only replayed the log would leave Capture search silently returning
   * nothing — ADR-0005's routine operation destroying a read surface.
   */
  it("still finds Captures after a full rebuild", async () => {
    await captures.put(aCapture("cap-1", "Coffee with Sarah"));
    await projections.reindexCaptures();

    await worker.rebuild();

    expect(await views.searchCaptures("Sarah")).toHaveLength(1);
  });

  it("honours the limit it is given", async () => {
    for (let index = 0; index < 5; index += 1) {
      await captures.put(aCapture(`cap-${index}`, "Sarah again"));
    }
    await projections.reindexCaptures();

    expect(await views.searchCaptures("Sarah", 2)).toHaveLength(2);
  });
});

/** A Capture with the text a search test is about. */
function aCapture(captureId: string, rawText: string) {
  return {
    captureId,
    source: "typed" as const,
    rawText,
    correctedText: null,
    transcriptionModel: null,
    sourceTimestamp: "2026-08-02T10:00:00.000Z",
    contentHash: `hash-${captureId}`,
    ingestedAt: "2026-08-02T10:00:01.000Z",
  };
}
