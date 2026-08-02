import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectionWorker } from "../../src/application/projection/projection-worker.js";
import { UpcastRegistry } from "../../src/domain/events/upcast-registry.js";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteCaptureStore } from "../../src/infrastructure/persistence/sqlite-capture-store.js";
import { SqliteEntityViewStore } from "../../src/infrastructure/persistence/sqlite-entity-view-store.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import { SqliteProjectionStore } from "../../src/infrastructure/persistence/sqlite-projection-store.js";
import {
  CORPUS,
  EXPECTED_EVENTS,
  entityId,
  syntheticCaptures,
  syntheticLog,
} from "../support/synthetic-corpus.js";
import { anEntityCreated } from "../support/projection-builders.js";
import { writePerformanceBaseline } from "../support/performance-baseline.js";

/**
 * **`qa.md` §8's seven bars, against the real projector.**
 *
 * The spike's harness was throwaway and its projection logic was a stand-in, so
 * its seven measurements are a baseline rather than a result — and the real
 * projector does more per event than the spike's did, which §8 names as the
 * most likely way this suite goes red.
 *
 * **Watch movement against the baseline column, not distance from the fail
 * column.** Every bar passes by 20× or better, so the bars alone will not catch
 * a regression until it is catastrophic. The committed JSON is what catches
 * drift.
 *
 * **If several bars degrade together, the conclusion is that the projection
 * model is doing too much work per event** — a design finding rather than a
 * test failure, and not a reason to change database.
 *
 * Out of the default run because a shared runner's timings are noise and a
 * flaky red build gets deleted rather than fixed.
 */

/** `qa.md` §8's table: the baseline the spike recorded, the pass bar, and the fail. */
const BARS = {
  rebuild: { baseline_ms: 215, bar_ms: 60_000, fail_ms: 300_000 },
  catchUp: { baseline_ms: 11.6, bar_ms: 500, fail_ms: 2_000 },
  entityView: { baseline_ms: 0.1, bar_ms: 50, fail_ms: 200 },
  captureSearch: { baseline_ms: 1.7, bar_ms: 100, fail_ms: 500 },
  append: { baseline_ms: 0.1, bar_ms: 10, fail_ms: 50 },
  databaseSize: { baseline_mb: 47.8, bar_mb: 2_048, fail_mb: 10_240 },
} as const;

/**
 * On disk rather than `:memory:`, because one of the seven bars is the file's
 * size and because WAL — which the append bar is about — does nothing without
 * a file (`runtime.md` §1).
 */
const DATABASE_FILE = join(tmpdir(), `otto-perf-${process.pid}.sqlite`);

let database: ReturnType<typeof openDatabase>;
let events: SqliteEventStore;
let projections: SqliteProjectionStore;
let views: SqliteEntityViewStore;
let worker: ProjectionWorker;
const results: Record<string, unknown> = {};

beforeAll(async () => {
  database = openDatabase(DATABASE_FILE);
  events = new SqliteEventStore(database);
  projections = new SqliteProjectionStore(database);
  views = new SqliteEntityViewStore(database);
  worker = new ProjectionWorker({ events, projections, upcasts: new UpcastRegistry() });

  const captures = new SqliteCaptureStore(database);
  for (const capture of syntheticCaptures()) await captures.put(capture);
  await events.append(syntheticLog());
}, 600_000);

afterAll(() => {
  writePerformanceBaseline(results, BARS);
  database.close();
});

describe("full projection rebuild from event zero", () => {
  it("rebuilds the whole log within the standing bar", async () => {
    const started = performance.now();
    const position = await worker.rebuild();
    const elapsed = performance.now() - started;
    results["rebuild_ms"] = elapsed;

    // A rebuild that silently no-ops is very fast (`qa.md` §8).
    expect(position).toBe(EXPECTED_EVENTS);
    expect(entityCount()).toBe(CORPUS.entities);
    expect(elapsed).toBeLessThanOrEqual(BARS.rebuild.bar_ms);
  });

  /** A second rebuild is byte-identical to the first. */
  it("produces the same projection on a second rebuild", async () => {
    const first = fingerprint();

    await worker.rebuild();

    expect(fingerprint()).toBe(first);
  });

  /**
   * Single-valued fields hold the last event's value, not the first.
   *
   * Every `single` field in the corpus is written twice — once with a
   * `superseded` value and once with the real one — so this fails if the fold
   * ever accumulates where it should replace.
   */
  it("holds the last value written to a single-valued field", async () => {
    const view = await views.entityView(entityId(0));

    expect(view?.entity.fields["location"]).toEqual(["value 0-3"]);
    expect(view?.entity.fields["summary"]).toEqual(["value 0-0"]);
  });

  /** Set fields accumulate rather than supersede. */
  it("accumulates members on a set field", async () => {
    const view = await views.entityView(entityId(0));

    expect(view?.entity.fields["aliases"]).toEqual(["member 0-0"]);
  });

  /** Provenance resolves through to model and confidence. */
  it("resolves provenance through to the model and confidence", async () => {
    const view = await views.entityView(entityId(0));

    const pointer = view?.provenance.get("name");
    expect(pointer?.provenance.modelVersion).toBe("qwen2.5-7b-instruct");
    expect(pointer?.provenance.confidence).toBeGreaterThan(0);
  });

  /** No field on any entity lacks a pointer. */
  it("leaves no field without a provenance pointer", () => {
    const missing = database
      .prepare(
        `SELECT COUNT(*) AS n FROM projection_entities entities
         WHERE (SELECT COUNT(*) FROM projection_field_provenance provenance
                WHERE provenance.entity_id = entities.entity_id) = 0`,
      )
      .get() as { n: number };

    expect(missing.n).toBe(0);
  });
});

describe("incremental catch-up", () => {
  /** Partial plus catch-up equals a full rebuild. */
  it("folds 100 new events within the standing bar", async () => {
    await worker.catchUp();
    const batch = Array.from({ length: 100 }, (_, index) =>
      anEntityCreated({ eventId: `evt-catchup-${index}`, aggregateId: `catchup-${index}` }),
    );
    await events.append(batch);

    const started = performance.now();
    await worker.catchUp();
    const elapsed = performance.now() - started;
    results["catch_up_ms"] = elapsed;

    expect(entityCount()).toBe(CORPUS.entities + 100);
    expect(elapsed).toBeLessThanOrEqual(BARS.catchUp.bar_ms);
  });

  it("equals a full rebuild after catching up", async () => {
    const incremental = fingerprint();

    await worker.rebuild();

    expect(fingerprint()).toBe(incremental);
  });
});

describe("the entity view query", () => {
  it("returns a row with relations and provenance within the standing bar", async () => {
    const durations = await timeRuns(200, async (run) => {
      const view = await views.entityView(entityId(run % CORPUS.entities));
      expect(view?.provenance.size).toBeGreaterThan(0);
    });
    results["entity_view_ms"] = percentile(durations, 0.95);

    expect(results["entity_view_ms"]).toBeLessThanOrEqual(BARS.entityView.bar_ms);
  });
});

describe("full-text search over Captures", () => {
  it("returns matches within the standing bar", async () => {
    await projections.reindexCaptures();

    const durations = await timeRuns(100, async () => {
      const hits = await views.searchCaptures("Helios");
      // A search returning nothing is fast and meaningless.
      expect(hits.length).toBeGreaterThan(0);
    });
    results["capture_search_ms"] = percentile(durations, 0.95);

    expect(results["capture_search_ms"]).toBeLessThanOrEqual(BARS.captureSearch.bar_ms);
  });

  /**
   * Entity search has no row in `qa.md` §8, and is timed against the Capture
   * bar.
   *
   * §8's table predates this index existing — the spike had no entity FTS to
   * measure. It is the same kind of query over a smaller corpus, so the Capture
   * bar is the honest one to hold it to rather than inventing a looser number
   * for the measurement that has no baseline to drift from.
   */
  it("searches entities within the Capture bar", async () => {
    const durations = await timeRuns(100, async () => {
      const hits = await views.searchEntities("Entity");
      expect(hits.length).toBeGreaterThan(0);
    });
    results["entity_search_ms"] = percentile(durations, 0.95);

    expect(results["entity_search_ms"]).toBeLessThanOrEqual(BARS.captureSearch.bar_ms);
  });
});

describe("event append with WAL", () => {
  it("appends within the standing bar", async () => {
    const durations = await timeRuns(200, async (run) => {
      await events.append([
        anEntityCreated({ eventId: `evt-append-${run}`, aggregateId: `append-${run}` }),
      ]);
    });
    results["append_ms"] = percentile(durations, 0.95);

    expect(results["append_ms"]).toBeLessThanOrEqual(BARS.append.bar_ms);
  });
});

describe("database size on disk", () => {
  it("stays within the standing bar", () => {
    const bytes = statSync(DATABASE_FILE).size;
    const megabytes = bytes / 1_024 / 1_024;
    results["database_size_mb"] = megabytes;

    expect(megabytes).toBeLessThanOrEqual(BARS.databaseSize.bar_mb);
  });
});

/** How many entities the projection holds. */
function entityCount(): number {
  const row = database.prepare("SELECT COUNT(*) AS n FROM projection_entities").get() as {
    n: number;
  };
  return row.n;
}

/**
 * A cheap stand-in for comparing two projections.
 *
 * Row counts and a checksum over the entity rows rather than the whole tables:
 * the byte-identical property is proved over arbitrary logs in
 * `tests/projection/rebuild-store.property.test.ts`, and what this needs is a
 * check that the corpus-sized rebuild did not change, without holding 3,000
 * rows in memory twice.
 */
function fingerprint(): string {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS entities, SUM(version) AS versions, SUM(LENGTH(fields)) AS bytes
       FROM projection_entities`,
    )
    .get() as { entities: number; versions: number; bytes: number };
  const relations = database.prepare("SELECT COUNT(*) AS n FROM projection_relations").get() as {
    n: number;
  };
  return JSON.stringify({ ...row, relations: relations.n });
}

/** Runs an operation `count` times, returning each duration in milliseconds. */
async function timeRuns(
  count: number,
  operation: (run: number) => Promise<void>,
): Promise<number[]> {
  const durations: number[] = [];
  for (let run = 0; run < count; run += 1) {
    const started = performance.now();
    await operation(run);
    durations.push(performance.now() - started);
  }
  return durations;
}

/** p95 rather than a mean, per `runtime.md` §4: a median hides the stall. */
function percentile(durations: readonly number[], fraction: number): number {
  const sorted = [...durations].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}
