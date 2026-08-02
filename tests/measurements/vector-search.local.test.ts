import { mkdirSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteEntityRepository } from "../../src/infrastructure/persistence/sqlite-entity-repository.js";
import { InMemoryEmbedder } from "../../src/infrastructure/embedding/in-memory-embedder.js";

/**
 * **The re-measurement `runtime.md` §4.3 asked for.**
 *
 * The 0.3 ms result in `runtime.md` §4's table belongs to `asg017/sqlite-vec`
 * 0.1.9 — a different project from the one §4.3 named as the extension Otto
 * ships, and now a different implementation again: ADR-0021 settled that Otto
 * does exact search in process over `BLOB` columns and depends on no extension
 * at all. So the old number describes neither the code nor the dependency, and
 * the bar has to be re-taken against what actually runs.
 *
 * The corpus is `qa.md` §8's: 3,000 entities at 384 dimensions, top-20. The bar
 * is unchanged at ≤ 100 ms, with > 500 ms the fail.
 *
 * Out of the default run for the reason the others are: a shared runner's
 * timings are noise, and a flaky red build gets deleted rather than fixed. The
 * bar catches a collapse; the committed baseline catches the drift that gets
 * you there.
 */
const ENTITY_COUNT = 3_000;
const TOP_K = 20;
const RUNS = 200;
const WARM_UP = 20;

/** `qa.md` §8's row, unchanged. The extension changed; the promise did not. */
const BAR_MS = 100;

const BASELINE_PATH = join(process.cwd(), "tests/baselines/vector-search.json");

describe("vector search over the specified corpus", () => {
  it("returns top-20 over 3,000 entities within the standing bar", async () => {
    const database = openDatabase();
    const repository = new SqliteEntityRepository(database);
    const embedder = new InMemoryEmbedder();

    await seedEntities(repository, embedder);
    const query = await embedder.embed("who is working on the Helios rollout");

    const durations: number[] = [];
    for (let run = 0; run < RUNS + WARM_UP; run += 1) {
      const started = performance.now();
      const found = await repository.byNearestEmbedding({
        embedding: query,
        type: "Person",
        limit: TOP_K,
      });
      const elapsed = performance.now() - started;
      if (run >= WARM_UP) durations.push(elapsed);

      // `qa.md` §8: a performance result is only meaningful if the thing being
      // timed did its job. A search that silently returned nothing is fast.
      expect(found).toHaveLength(TOP_K);
    }

    const measurement = summarise(durations);
    writeBaseline(measurement);

    expect(measurement.p95_ms).toBeLessThanOrEqual(BAR_MS);
    database.close();
  });
});

/** 3,000 Person entities, each with a name and a vector derived from it. */
async function seedEntities(
  repository: SqliteEntityRepository,
  embedder: InMemoryEmbedder,
): Promise<void> {
  const names = Array.from({ length: ENTITY_COUNT }, (_, index) => `Person Number ${index}`);
  const vectors = await embedder.embedAll(names);

  for (const [index, name] of names.entries()) {
    const id = `per-${index}`;
    repository.putEntity({ id, type: "Person", fields: { name: [name] }, version: 1 });
    repository.putEmbedding(id, "Person", {
      vector: vectors[index]!,
      modelVersion: embedder.modelVersion,
    });
  }
}

interface Measurement {
  readonly median_ms: number;
  readonly p95_ms: number;
}

/**
 * p95 rather than a mean, per `runtime.md` §4: the bars read as user-facing
 * promises, and a median hides the stall a user would notice.
 */
function summarise(durations: readonly number[]): Measurement {
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    median_ms: sorted[Math.floor(sorted.length * 0.5)]!,
    p95_ms: sorted[Math.floor(sorted.length * 0.95)]!,
  };
}

function writeBaseline(measurement: Measurement): void {
  mkdirSync(join(process.cwd(), "tests/baselines"), { recursive: true });
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        measurement: "vector-search-top-20",
        what_is_timed:
          "Exact cosine search over 3,000 Person embeddings at 384 dimensions, " +
          "returning the nearest 20. In-process over BLOB columns per ADR-0021, " +
          "not through a loadable extension. Includes reading every row back out " +
          "of SQLite, which is the dominant cost and the one a real query pays.",
        corpus: { entities: ENTITY_COUNT, dimensions: 384, top_k: TOP_K },
        runs: RUNS,
        ...measurement,
        bar_ms: BAR_MS,
        fail_ms: 500,
        machine: arch(),
        os: platform(),
        supersedes:
          "runtime.md §4's 0.3 ms row, which was measured on asg017/sqlite-vec 0.1.9 — " +
          "a different project from the extension §4.3 named, and a different " +
          "implementation from the one ADR-0021 settled on.",
        embeddings:
          "Synthetic, from InMemoryEmbedder. This measures the index and not " +
          "retrieval quality, which stays an eval-set question (runtime.md §4.2).",
      },
      null,
      2,
    )}\n`,
  );
}
