import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ProjectionWorker } from "../../src/application/projection/projection-worker.js";
import type { DomainEvent } from "../../src/domain/events/domain-event.js";
import { UpcastRegistry } from "../../src/domain/events/upcast-registry.js";
import { serialiseKnowledge } from "../../src/domain/knowledge/serialise-knowledge.js";
import { projectFromZero } from "../../src/domain/knowledge/project-entity.js";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import { SqliteProjectionStore } from "../../src/infrastructure/persistence/sqlite-projection-store.js";
import { PROJECTION_TABLES } from "../../src/infrastructure/persistence/projection-tables.js";
import { anEventLog } from "../support/log-arbitraries.js";

/**
 * The rebuild property against the real database.
 *
 * `tests/domain/rebuild.property.test.ts` holds the same property over the pure
 * fold, where a counterexample is legible. This one is what `qa.md` §7.1
 * actually asks for — **dropping every projection and rebuilding** — since the
 * fold being deterministic says nothing about whether the tables round-trip it
 * faithfully. The two failures are different: the fold can be correct while the
 * store loses a field, and only this test sees that.
 */

/** A fresh database with a worker over it. */
function harness() {
  const database = openDatabase();
  const events = new SqliteEventStore(database);
  const projections = new SqliteProjectionStore(database, () => "2026-08-02T10:00:00.000Z");
  const worker = new ProjectionWorker({ events, projections, upcasts: new UpcastRegistry() });
  return { database, events, projections, worker };
}

/**
 * A worker writing to `database`'s projections but reading a log held
 * elsewhere.
 *
 * What a rebuild against a shorter log looks like from the projection's side.
 * The event store is a separate in-memory database because `events` refuses
 * DELETE, so the only way to present the worker with fewer events is to give it
 * a different log.
 */
async function workerOver(
  database: ReturnType<typeof openDatabase>,
  log: readonly DomainEvent[],
): Promise<ProjectionWorker> {
  const events = new SqliteEventStore(openDatabase());
  await events.append(log);
  return new ProjectionWorker({
    events,
    projections: new SqliteProjectionStore(database, () => "2026-08-02T10:00:00.000Z"),
    upcasts: new UpcastRegistry(),
  });
}

/**
 * Every projection table's rows, as one comparable value.
 *
 * Ordered by the row's own columns rather than by `rowid`. **`rowid` is not
 * part of the projection**: it records the order SQLite happened to insert
 * rows, which for the provenance table depends on which batch boundary a
 * catch-up used — a delete-and-reinsert per entity write means an entity
 * touched in a later batch lands later in the file. Two projections holding
 * identical knowledge differ there, and comparing on it would fail a rebuild
 * that is correct.
 *
 * This is the same distinction `serialiseKnowledge` draws for the in-memory
 * fold: byte-identical means the same knowledge, not the same physical layout.
 */
function tablesOf(database: ReturnType<typeof openDatabase>): string {
  return JSON.stringify(
    PROJECTION_TABLES.map((table) => [
      table,
      database.prepare(`SELECT * FROM ${table} ORDER BY ${ORDER_BY[table]}`).all(),
    ]),
  );
}

/** Each projection table's primary key, which is the order that is meaningful. */
const ORDER_BY: Record<(typeof PROJECTION_TABLES)[number], string> = {
  projection_entities: "entity_id",
  projection_aliases: "entity_id, alias",
  projection_relations: "relation_name, from_id, to_id",
  projection_field_provenance: "entity_id, field",
  projection_embeddings: "entity_id",
  projection_redirects: "from_id",
};

describe("dropping every projection and rebuilding", () => {
  it("produces byte-identical tables for any log", async () => {
    await fc.assert(
      fc.asyncProperty(anEventLog, async (log) => {
        const { database, events, worker } = harness();
        await events.append(log);

        await worker.rebuild();
        const first = tablesOf(database);
        await worker.rebuild();

        expect(tablesOf(database)).toBe(first);
      }),
      { numRuns: 60 },
    );
  });

  /**
   * A rebuild after an incremental run equals the incremental run. This is the
   * check that catches a store that accumulates — an alias table that unions
   * across writes passes every example test and fails here.
   */
  it("equals the incremental projection", async () => {
    await fc.assert(
      fc.asyncProperty(anEventLog, async (log) => {
        const { database, events, worker } = harness();
        await events.append(log);
        await worker.catchUp();
        const incremental = tablesOf(database);

        await worker.rebuild();

        expect(tablesOf(database)).toBe(incremental);
      }),
      { numRuns: 60 },
    );
  });

  /**
   * Partial, then catch up, equals a full rebuild (`qa.md` §8).
   *
   * The log is appended in two halves with a catch-up between them, so the
   * worker genuinely resumes from stored state rather than folding a log it
   * happens to hold in memory.
   */
  it("equals a full rebuild when the log arrives in two halves", async () => {
    await fc.assert(
      fc.asyncProperty(anEventLog, fc.nat(), async (log, cut) => {
        const boundary = log.length === 0 ? 0 : cut % (log.length + 1);
        const { database, events, worker } = harness();

        await events.append(log.slice(0, boundary));
        await worker.catchUp();
        await events.append(log.slice(boundary));
        await worker.catchUp();
        const incremental = tablesOf(database);

        await worker.rebuild();
        expect(tablesOf(database)).toBe(incremental);
      }),
      { numRuns: 60 },
    );
  });
});

describe("a rebuild against a smaller log", () => {
  /**
   * **The check that `reset` actually empties every table.**
   *
   * Appending to a log and rebuilding cannot catch a table that fails to
   * clear, because a rebuild over a longer log rewrites everything the shorter
   * one wrote. Only a projection that must *shrink* exposes it — which is the
   * real operation `qa.md` §9 describes: a projection is corrupt, so delete it
   * and rebuild from a log that no longer justifies what is in the tables.
   *
   * The log itself is never truncated — `events` refuses DELETE, and that
   * trigger is a Tier 0 guarantee worth more than this test's convenience. So
   * the shrinking is done the way it happens in practice: the projection is
   * built against one log, and then rebuilt by a worker reading a different,
   * shorter one. What is left in the tables afterwards must be exactly what the
   * shorter log justifies.
   */
  it("leaves nothing behind from the longer log", async () => {
    await fc.assert(
      fc.asyncProperty(anEventLog, fc.nat(), async (log, cut) => {
        const boundary = log.length === 0 ? 0 : cut % (log.length + 1);
        const prefix = log.slice(0, boundary);

        const shrunk = harness();
        await shrunk.events.append(log);
        await shrunk.worker.rebuild();
        await (await workerOver(shrunk.database, prefix)).rebuild();

        const only = harness();
        await only.events.append(prefix);
        await only.worker.rebuild();

        expect(tablesOf(shrunk.database)).toBe(tablesOf(only.database));
      }),
      { numRuns: 60 },
    );
  });
});

describe("the state the store hands back", () => {
  /**
   * `read()` is the inverse of `write()`, which is what makes resuming
   * mid-log safe. A field lost on the way out and back would make catch-up
   * disagree with a rebuild, silently.
   */
  it("round-trips the folded state for any log", async () => {
    await fc.assert(
      fc.asyncProperty(anEventLog, async (log) => {
        const { events, projections, worker } = harness();
        await events.append(log);
        await worker.rebuild();

        const readBack = await projections.read();

        expect(serialiseKnowledge(readBack)).toBe(serialiseKnowledge(projectFromZero(log)));
      }),
      { numRuns: 60 },
    );
  });
});

describe("provenance in the tables", () => {
  /** No field lacks a pointer, checked against the rows rather than the fold. */
  it("leaves no projected field without a provenance row", async () => {
    await fc.assert(
      fc.asyncProperty(anEventLog, async (log) => {
        const { database, events, worker } = harness();
        await events.append(log);
        await worker.rebuild();

        const entities = database
          .prepare("SELECT entity_id, fields FROM projection_entities")
          .all() as { entity_id: string; fields: string }[];
        const pointers = database
          .prepare("SELECT entity_id, field FROM projection_field_provenance")
          .all() as { entity_id: string; field: string }[];

        const held = new Set(pointers.map((row) => `${row.entity_id}/${row.field}`));
        for (const entity of entities) {
          for (const field of Object.keys(JSON.parse(entity.fields))) {
            expect(held.has(`${entity.entity_id}/${field}`)).toBe(true);
          }
        }
      }),
      { numRuns: 60 },
    );
  });
});
