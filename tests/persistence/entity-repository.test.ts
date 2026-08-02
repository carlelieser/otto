import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteEntityRepository } from "../../src/infrastructure/persistence/sqlite-entity-repository.js";
import { anEntity } from "../support/knowledge-builders.js";

/**
 * The entity projection, tested against SQLite rather than against a fake.
 *
 * `add.md` §9's rule: a storage port's offline mode is `:memory:`, which is the
 * real adapter with no disk. Slice 0 built an in-memory `EventStore` that
 * silently disagreed with the SQLite one about whether a stored event could be
 * edited in place, and no test noticed because each was only ever compared
 * against itself.
 */

let database: Database.Database;
let repository: SqliteEntityRepository;

beforeEach(() => {
  database = openDatabase();
  repository = new SqliteEntityRepository(database);
});

afterEach(() => database.close());

describe("reading an entity by id", () => {
  it("returns the entity that was stored", async () => {
    const sarah = anEntity({ fields: { name: ["Sarah Chen"], employer: ["Acme"] } });
    repository.putEntity(sarah);

    expect(await repository.byId(sarah.id)).toEqual(sarah);
  });

  it("returns undefined for an id no entity has", async () => {
    expect(await repository.byId("per-nobody")).toBeUndefined();
  });

  it("returns the latest state after an entity is written twice", async () => {
    repository.putEntity(anEntity({ fields: { name: ["Sarah Chen"] }, version: 1 }));
    repository.putEntity(anEntity({ fields: { name: ["Sarah Okonkwo"] }, version: 2 }));

    const stored = await repository.byId("per-sarah");
    expect(stored?.fields["name"]).toEqual(["Sarah Okonkwo"]);
    expect(stored?.version).toBe(2);
  });
});

describe("exact name and alias matching", () => {
  it("finds an entity by its name", async () => {
    repository.putEntity(anEntity({ fields: { name: ["Sarah Chen"] } }));

    const found = await repository.byExactName("Sarah Chen", "Person");
    expect(found.map((entity) => entity.id)).toEqual(["per-sarah"]);
  });

  it("matches case-insensitively", async () => {
    repository.putEntity(anEntity({ fields: { name: ["Sarah Chen"] } }));

    expect(await repository.byExactName("sarah chen", "Person")).toHaveLength(1);
  });

  /** `aliases` "feeds candidate generation directly" (`schema.md` §2). */
  it("finds an entity by an alias", async () => {
    repository.putEntity(anEntity({ fields: { name: ["Sarah Chen"], aliases: ["Sarah C"] } }));

    const found = await repository.byExactName("Sarah C", "Person");
    expect(found.map((entity) => entity.id)).toEqual(["per-sarah"]);
  });

  /**
   * Two people may share a name, and that ambiguity is precisely what the
   * scorer exists to resolve — so generation returns both rather than picking.
   */
  it("returns every entity sharing a name", async () => {
    repository.putEntity(anEntity({ id: "per-1", fields: { name: ["Sarah"] } }));
    repository.putEntity(anEntity({ id: "per-2", fields: { name: ["Sarah"] } }));

    expect(await repository.byExactName("Sarah", "Person")).toHaveLength(2);
  });

  it("does not match an entity of a different type", async () => {
    repository.putEntity(anEntity({ id: "proj-1", type: "Project", fields: { name: ["Helios"] } }));

    expect(await repository.byExactName("Helios", "Person")).toEqual([]);
  });

  it("returns an entity once even when its name and an alias both match", async () => {
    repository.putEntity(anEntity({ fields: { name: ["Sarah"], aliases: ["sarah"] } }));

    expect(await repository.byExactName("Sarah", "Person")).toHaveLength(1);
  });

  /**
   * The projection is derived: what an entity's aliases are is whatever the log
   * says. A rebuild that unioned across writes would accumulate aliases the log
   * no longer supports.
   */
  it("replaces aliases rather than accumulating them across writes", async () => {
    repository.putEntity(anEntity({ fields: { name: ["Sarah"], aliases: ["Sar"] } }));
    repository.putEntity(anEntity({ fields: { name: ["Sarah"], aliases: ["Sarah C"] } }));

    expect(await repository.byExactName("Sar", "Person")).toEqual([]);
    expect(await repository.byExactName("Sarah C", "Person")).toHaveLength(1);
  });
});

describe("fuzzy name matching", () => {
  /**
   * The failure this source exists for: `runtime.md` §2 names proper-noun
   * recall as the transcription metric that matters, and "Sara" for "Sarah" is
   * what a small model produces. Exact matching misses it entirely.
   */
  it("finds a name a transcription model got slightly wrong", async () => {
    repository.putEntity(anEntity({ fields: { name: ["Sarah Chen"] } }));

    const found = await repository.byFuzzyName("Sara Chen", "Person");
    expect(found.map((entity) => entity.id)).toEqual(["per-sarah"]);
  });

  it("does not match an unrelated name of similar length", async () => {
    repository.putEntity(anEntity({ fields: { name: ["Sarah Chen"] } }));

    expect(await repository.byFuzzyName("Marco Silva", "Person")).toEqual([]);
  });

  it("returns nearer names first", async () => {
    repository.putEntity(anEntity({ id: "per-1", fields: { name: ["Sarah Chen"] } }));
    repository.putEntity(anEntity({ id: "per-2", fields: { name: ["Sarah Chan"] } }));

    const found = await repository.byFuzzyName("Sarah Chen", "Person");
    expect(found[0]?.id).toBe("per-1");
  });

  it("does not match across entity types", async () => {
    repository.putEntity(anEntity({ id: "proj-1", type: "Project", fields: { name: ["Sarah"] } }));

    expect(await repository.byFuzzyName("Sarah", "Person")).toEqual([]);
  });
});

describe("relations", () => {
  const involvement = {
    name: "involves",
    from: { id: "proj-helios", type: "Project" },
    to: { id: "per-sarah", type: "Person" },
  } as const;

  it("returns a relation from either end", async () => {
    repository.putRelation(involvement);

    expect(await repository.relationsOf("proj-helios")).toEqual([involvement]);
    expect(await repository.relationsOf("per-sarah")).toEqual([involvement]);
  });

  it("returns nothing for an entity with no relations", async () => {
    expect(await repository.relationsOf("per-nobody")).toEqual([]);
  });

  it("stores one edge when the same relation is written twice", async () => {
    repository.putRelation(involvement);
    repository.putRelation(involvement);

    expect(await repository.relationsOf("per-sarah")).toHaveLength(1);
  });

  /** Direction is meaningful: `blocks` from A to B is not `blocks` from B to A. */
  it("keeps two directions of one relation as separate edges", async () => {
    const forward = {
      name: "blocks",
      from: { id: "task-1", type: "Task" },
      to: { id: "task-2", type: "Task" },
    } as const;
    repository.putRelation(forward);
    repository.putRelation({ ...forward, from: forward.to, to: forward.from });

    expect(await repository.relationsOf("task-1")).toHaveLength(2);
  });
});
