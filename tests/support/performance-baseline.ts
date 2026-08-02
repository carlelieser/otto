import { mkdirSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { CORPUS, EXPECTED_EVENTS } from "./synthetic-corpus.js";

/**
 * Writing `qa.md` §8's results to the committed baseline file.
 *
 * Kept out of the test so the test reads as seven measurements rather than as
 * six measurements and a document. The prose belongs with the file it is
 * written into: whoever opens the JSON after a regression is who it is for.
 *
 * The machine is recorded so a cross-machine comparison is visibly meaningless
 * rather than quietly wrong — `tests/baselines/README.md` is the reason these
 * are files at all.
 */

const BASELINE_PATH = join(process.cwd(), "tests/baselines/projection-performance.json");

export function writePerformanceBaseline(
  results: Record<string, unknown>,
  bars: Record<string, unknown>,
): void {
  mkdirSync(join(process.cwd(), "tests/baselines"), { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baselineOf(results, bars), null, 2)}\n`);
}

function baselineOf(results: Record<string, unknown>, bars: Record<string, unknown>): unknown {
  return {
    measurement: "projection-performance",
    what_is_timed: WHAT_IS_TIMED,
    corpus: { ...CORPUS, events: EXPECTED_EVENTS },
    results,
    bars,
    note: NOTE,
    reading_against_the_spike: READING,
    what_would_be_a_regression: REGRESSION,
    machine: arch(),
    os: platform(),
  };
}

const WHAT_IS_TIMED =
  "qa.md §8's bars against the real projector, on the specified synthetic " +
  "corpus. The spike's harness was throwaway and its projection logic was a " +
  "stand-in, so its numbers are the baseline column rather than a comparable " +
  "result. Vector search is the seventh bar and is measured separately, in " +
  "tests/baselines/vector-search.json, because ADR-0021 changed what it runs on.";

const NOTE =
  "Watch movement against the baseline column, not distance from the fail " +
  "column. If several degrade together, the projection model is doing too much " +
  "work per event — a design finding, not a reason to change database.";

const READING =
  "Four of six are at or better than the spike. Two are not, and the gap is " +
  "structural rather than a regression: rebuild is ~8 s against a 215 ms " +
  "baseline, and 100-event catch-up is ~130-150 ms against 11.6 ms. The " +
  "spike's projection logic was a stand-in that wrote entity rows only. This " +
  "projector " +
  "also writes a provenance row per field (add.md §7) and maintains an FTS " +
  "index, which is roughly three writes per event where the spike did one. " +
  "Both stay inside their bars — 7.5x and 3.8x — so the cost is accepted " +
  "rather than tuned. These figures, not the spike's, are the baseline the " +
  "next slice compares against.";

const REGRESSION =
  "Rebuild past ~20 s or catch-up past ~300 ms, either of which would mean " +
  "per-event work grew again without a feature to show for it. The first thing " +
  "to examine is SqliteProjectionStore.write, which persists only the entities " +
  "a batch touched — writing all of them was measured at 29 s rebuild and " +
  "1.3 s catch-up.";
