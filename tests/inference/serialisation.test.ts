import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteEntityRepository } from "../../src/infrastructure/persistence/sqlite-entity-repository.js";
import {
  type MentionToResolve,
  type ResolutionDependencies,
  resolveMention,
} from "../../src/inference/resolution/resolve-capture.js";

/**
 * **One Sarah, not two** (`qa.md` §6.2, Slice 4's verification).
 *
 * Two notes mentioning the same *new* entity is the race the corpus carries
 * deliberately. Both notes resolve against a graph that does not contain Sarah
 * yet, so both reach "none of these" and both propose a create — and if they
 * are resolved concurrently against one snapshot of the graph, the second never
 * sees the first's entity and Otto gets two Sarahs from one person.
 *
 * `add.md` §4 answers this by **serialising the pipeline to one Capture at a
 * time**. That is not a lock, and it is not optimistic concurrency — it is the
 * process model, and the property it buys is exactly this one. These tests hold
 * the seam: they run the second resolution *after* the first's create has
 * landed, which is what serialisation guarantees and what a concurrent
 * implementation would not.
 */

let database: Database.Database;
let repository: SqliteEntityRepository;

beforeEach(() => {
  database = openDatabase();
  repository = new SqliteEntityRepository(database);
});

afterEach(() => database.close());

function dependenciesOver(entities: SqliteEntityRepository): ResolutionDependencies {
  return {
    reads: {
      byExactName: (name, type) => entities.byExactName(name, type),
      byFuzzyName: (name, type) => entities.byFuzzyName(name, type),
      byNearestEmbedding: (query) => entities.byNearestEmbedding(query),
    },
    relatedIdsFor: async () => new Map(),
    // Never reached: neither note is ambiguous, which is the point — a create
    // for an unknown name should not cost a model call.
    adjudicate: async () => ({
      chosenIndex: null,
      provider: "in-memory",
      modelVersion: "canned",
    }),
  };
}

function aNoteMentioning(text: string, noteText: string): MentionToResolve {
  return {
    text,
    entityType: "Person",
    noteText,
    capturedAt: "2026-08-01T09:00:00.000Z",
    coResolvedIds: [],
  };
}

/** What the executor would write after a create resolves to nothing. */
function createSarah(): void {
  repository.putEntity({
    id: "per-sarah",
    type: "Person",
    fields: { name: ["Sarah Chen"] },
    version: 1,
  });
}

describe("two notes mentioning the same new entity", () => {
  it("proposes a create for the first note, which knows nothing", async () => {
    const first = await resolveMention(
      aNoteMentioning("Sarah Chen", "Coffee with Sarah Chen."),
      dependenciesOver(repository),
    );

    expect(first.resolution.outcome).toBe("unambiguous");
    expect(first.resolution.entityId).toBeNull();
  });

  /**
   * The property serialisation buys. The second note resolves against a graph
   * the first note's create has already landed in, so it matches rather than
   * creating again.
   */
  it("resolves the second note to the entity the first one created", async () => {
    await resolveMention(
      aNoteMentioning("Sarah Chen", "Coffee with Sarah Chen."),
      dependenciesOver(repository),
    );
    createSarah();

    const second = await resolveMention(
      aNoteMentioning("Sarah Chen", "Sarah Chen sent the contract."),
      dependenciesOver(repository),
    );

    expect(second.resolution.outcome).toBe("matched");
    expect(second.resolution.entityId).toBe("per-sarah");
  });

  it("leaves one Sarah in the projection, not two", async () => {
    createSarah();
    const second = await resolveMention(
      aNoteMentioning("Sarah Chen", "Sarah Chen sent the contract."),
      dependenciesOver(repository),
    );

    // The second note matched, so nothing creates a second row.
    expect(second.resolution.entityId).toBe("per-sarah");
    expect(await repository.byExactName("Sarah Chen", "Person")).toHaveLength(1);
  });

  /**
   * The failure mode named, so the test above is visibly about something.
   *
   * A pipeline that resolved both notes against a graph neither create had
   * landed in produces two "none of these" and therefore two Sarahs. Modelled
   * here as a second empty graph, because that is what a stale pre-create view
   * amounts to — and it is exactly what serialising to one Capture at a time
   * prevents (`add.md` §4).
   */
  it("would create twice if the second note resolved against a pre-create view", async () => {
    const staleDatabase = openDatabase();
    const staleView = new SqliteEntityRepository(staleDatabase);

    const first = await resolveMention(
      aNoteMentioning("Sarah Chen", "Coffee."),
      dependenciesOver(repository),
    );
    createSarah();
    const concurrent = await resolveMention(
      aNoteMentioning("Sarah Chen", "Contract."),
      dependenciesOver(staleView),
    );

    expect(first.resolution.entityId).toBeNull();
    expect(concurrent.resolution.entityId, "the duplicate serialisation prevents").toBeNull();
    staleDatabase.close();
  });
});
