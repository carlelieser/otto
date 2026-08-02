import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionWorker } from "../../src/application/projection/projection-worker.js";
import { UpcastRegistry } from "../../src/domain/events/upcast-registry.js";
import { relationsIn, resolveRedirect } from "../../src/domain/knowledge/project-entity.js";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import { SqliteEntityViewStore } from "../../src/infrastructure/persistence/sqlite-entity-view-store.js";
import { SqliteProjectionStore } from "../../src/infrastructure/persistence/sqlite-projection-store.js";
import type { EventStore } from "../../src/ports/event-store.js";
import {
  aFieldSet,
  anEntitiesMerged,
  anEntitiesRelated,
  anEntityCreated,
} from "../support/projection-builders.js";

/**
 * **A merge through the real projection tables** (`qa.md` §7.4).
 *
 * The fold's semantics are tested against the pure function in
 * `tests/domain/merge-fold.test.ts`, where a counterexample is legible. This
 * file is about the half that only SQLite can be wrong about: that the
 * merged-away row actually leaves `projection_entities`, that the redirect
 * lands in `projection_redirects`, and that both survive the round-trip a
 * resuming worker makes.
 */

let events: EventStore;
let views: SqliteEntityViewStore;
let projections: SqliteProjectionStore;
let worker: ProjectionWorker;

beforeEach(() => {
  const database = openDatabase();
  events = new SqliteEventStore(database);
  views = new SqliteEntityViewStore(database);
  projections = new SqliteProjectionStore(database);
  worker = new ProjectionWorker({ events, projections, upcasts: new UpcastRegistry() });
});

/** Two Sarahs in the log, the second merged into the first. */
async function mergeTwoSarahs(): Promise<void> {
  await events.append([
    anEntityCreated({ aggregateId: "per-4172" }),
    anEntityCreated({ aggregateId: "per-4891", payload: { name: "Sara Chen" } }),
    anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-4172" }),
  ]);
  await worker.catchUp();
}

/** Helios involving one of the two Sarahs, folded into the projection. */
async function givenHeliosInvolving(toId: string): Promise<void> {
  await events.append([
    anEntityCreated({ aggregateId: "proj-1", payload: { entityType: "Project", name: "Helios" } }),
    anEntitiesRelated({ aggregateId: "proj-1", toId }),
  ]);
  await worker.catchUp();
}

describe("a merge in the projection tables", () => {
  /** ADR-0009: one entity afterwards, and the merged-away id in no list view. */
  it("leaves one entity where the log created two", async () => {
    await mergeTwoSarahs();

    const people = await views.entitiesOfType("Person");

    expect(people.map((person) => person.id)).toEqual(["per-4172"]);
  });

  /**
   * The merged-away id is gone from the entity table and still resolvable,
   * which is the whole of what a redirect is: reads resolve *through* it, so
   * asking the view for #4891 answers with the survivor rather than nothing.
   */
  it("answers a read of the merged-away id with the survivor", async () => {
    await mergeTwoSarahs();

    expect((await views.entityView("per-4891"))?.entity.id).toBe("per-4172");
  });

  it("writes the redirect the merged-away id resolves through", async () => {
    await mergeTwoSarahs();

    const state = await projections.read();

    expect(resolveRedirect(state, "per-4891")).toBe("per-4172");
  });

  /**
   * The round-trip a worker resuming mid-log makes. A redirect that did not
   * survive it would be rebuilt only by replaying from zero, and a catch-up
   * would resolve a merged-away id to itself — an entity nothing can show.
   */
  it("carries redirects back out of the tables", async () => {
    await mergeTwoSarahs();
    await events.append([
      aFieldSet({ field: "employer", value: "Acme" }, { aggregateId: "per-4172" }),
    ]);
    await worker.catchUp();

    const state = await projections.read();

    expect(resolveRedirect(state, "per-4891")).toBe("per-4172");
  });

  /**
   * An edge that named the merged-away identity must not survive in the table
   * alongside its repointed self. The fold rebuilds the relation map, but the
   * store only ever inserted rows — so a stale row would leave the survivor's
   * page showing an edge to an entity that appears in no list view.
   */
  it("leaves no edge in the table still naming the merged-away id", async () => {
    await givenHeliosInvolving("per-4891");
    await mergeTwoSarahs();

    const state = await projections.read();

    expect(relationsIn(state).map((relation) => relation.to.id)).toEqual(["per-4172"]);
  });

  /**
   * Read back through the projection state rather than through the survivor's
   * view, because a view filters by the survivor's id and cannot see an orphan
   * row left behind — which is exactly how a stale edge stays invisible until
   * something enumerates the table.
   */
  it("shows the repointed edge on the survivor", async () => {
    await givenHeliosInvolving("per-4891");
    await mergeTwoSarahs();

    const view = await views.entityView("per-4172");

    expect(view?.relations.map((relation) => relation.to.id)).toEqual(["per-4172"]);
  });

  it("carries the loser's conflicting value into the survivor's notes", async () => {
    await mergeTwoSarahs();

    const view = await views.entityView("per-4172");

    expect(view?.entity.fields["notes"]).toEqual(["name: Sara Chen"]);
  });

  /**
   * A rebuild drops every projection and replays. The redirect must come back,
   * since it is derived from the log like everything else — a rebuild that lost
   * it would silently break every pre-merge reference.
   */
  it("restores redirects on a full rebuild", async () => {
    await mergeTwoSarahs();
    await worker.rebuild();

    const state = await projections.read();

    expect(resolveRedirect(state, "per-4891")).toBe("per-4172");
    expect((await views.entitiesOfType("Person")).map((one) => one.id)).toEqual(["per-4172"]);
  });
});

describe("nothing in history is rewritten", () => {
  /**
   * `add.md` §6 and ADR-0009: `PersonCreated(#4891)` and every event against
   * #4891 remain exactly as they were, because at the time Otto genuinely
   * believed there were two.
   */
  it("leaves every event against the merged-away id exactly as it was", async () => {
    await events.append([
      anEntityCreated({ aggregateId: "per-4891", eventId: "evt-created" }),
      aFieldSet(
        { field: "employer", value: "Acme" },
        { aggregateId: "per-4891", eventId: "evt-set" },
      ),
      anEntityCreated({ aggregateId: "per-4172" }),
    ]);
    const before = await events.readForward(0, 100);

    await events.append([anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-4172" })]);
    await worker.catchUp();

    const after = await events.readForward(0, 100);
    expect(after.slice(0, before.length)).toEqual(before);
  });
});
