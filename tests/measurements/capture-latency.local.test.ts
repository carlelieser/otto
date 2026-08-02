import { mkdirSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CaptureIngestion } from "../../src/application/pipeline/ingest-capture.js";
import { createExecutor } from "../../src/composition-root.js";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteCaptureStore } from "../../src/infrastructure/persistence/sqlite-capture-store.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";

/**
 * Capture latency: text in hand to a durable Capture.
 *
 * A different span from Slice 1's `runtime-latency.json`, which timed the
 * hotkey to a painted window with no storage under it. The two keep separate
 * baselines on purpose — this one is what PRD §4.1's "capture costs nothing"
 * ultimately rests on, and it is the number later slices must not regress.
 *
 * Out of the default run because a shared runner's timing is noise, and a flaky
 * red build gets deleted rather than fixed. The bar catches a collapse; the
 * baseline catches the drift that gets you there (`qa.md` §8).
 *
 * What is *not* timed here: the hotkey, the window, and the WebView, which
 * Slice 1 measured against a real event loop that `vitest` cannot provide. This
 * is the sidecar half — normalise, derive, write the row, append the event —
 * and the two are additive rather than overlapping.
 */
const RUNS = 200;
const WARM_UP = 20;
const BASELINE_PATH = join(process.cwd(), "tests/baselines/capture-latency.json");

/** Generous, because the point is to notice a collapse rather than to grade. */
const BAR_MS = 50;

describe("capture latency", () => {
  it("measures text-to-durable-Capture and records the baseline", async () => {
    const database = openDatabase();
    const captures = new SqliteCaptureStore(database);
    const events = new SqliteEventStore(database);
    const ingestion = new CaptureIngestion({ captures, events }, createExecutor(events), () =>
      new Date().toISOString(),
    );

    const durations: number[] = [];
    for (let run = 0; run < RUNS + WARM_UP; run += 1) {
      // Distinct text per run: re-ingesting identical input is a no-op, which
      // would measure the idempotency check rather than a capture.
      const started = performance.now();
      await ingestion.ingest({
        source: "typed",
        rawText: `Coffee with Sarah about the Helios rollout, run ${run}.`,
        sourceTimestamp: new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"),
        transcriptionModel: null,
      });
      const elapsed = performance.now() - started;
      if (run >= WARM_UP) durations.push(elapsed);
    }
    database.close();

    const median = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    writeBaseline(median, p95);

    expect(median).toBeLessThan(BAR_MS);
  });
});

function percentile(durations: readonly number[], nth: number): number {
  const sorted = [...durations].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((nth / 100) * sorted.length));
  return sorted[index]!;
}

/**
 * The machine is recorded alongside the numbers so a cross-machine comparison
 * is visibly meaningless rather than quietly wrong. Re-take it when hardware
 * changes.
 */
function writeBaseline(medianMs: number, p95Ms: number): void {
  mkdirSync(join(process.cwd(), "tests/baselines"), { recursive: true });
  const baseline = {
    measurement: "text-to-durable-capture",
    what_is_timed:
      "Normalise, derive the capture id, write the `captures` row, and append " +
      "CaptureIngested through the executor, against SQLite in memory. Excludes " +
      "the hotkey, the window, and the WebView, which runtime-latency.json covers.",
    runs: RUNS,
    median_ms: Number(medianMs.toFixed(6)),
    p95_ms: Number(p95Ms.toFixed(6)),
    bar_ms: BAR_MS,
    machine: arch(),
    os: platform(),
    excluded:
      "Transcription, which is measured as a multiple of realtime rather than " +
      "a fixed budget (`runtime.md` §2), and the host-side hotkey and window.",
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
}
