import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AnthropicExtractor } from "../../src/infrastructure/llm/anthropic-extractor.js";
import { LocalExtractor } from "../../src/infrastructure/llm/local-extractor.js";
import { OpenAiExtractor } from "../../src/infrastructure/llm/openai-extractor.js";
import type { Extractor } from "../../src/ports/extractor.js";
import { checkFloor, formatFloor } from "./floor.js";
import { formatMetrics, type ExtractionMetrics } from "./metrics.js";
import { failures, runCorpus } from "./run-corpus.js";

/**
 * **The measurement. This slice's exit condition, and the one open gate in the
 * project** (PRD §9, ADR-0013, `runtime.md` §2).
 *
 * It runs the same corpus through the local path and, where credentials are
 * present, through each cloud path, and reports `qa.md` §6.1's metric table per
 * provider and model version. The number that matters is the *margin*: local is
 * expected to be worse, and §6.3 asks how much worse to be answered with data
 * rather than assumed.
 *
 * It is a `.local.test.ts` because it needs a running model, which a shared
 * runner does not have — and a test whose dependency is absent skips rather
 * than fails, so `npm run test:local` is meaningful on any machine. It is not
 * excluded because it is slow or awkward: it is excluded because CI cannot run
 * it, and the CI-runnable half is `unconfigured.test.ts`.
 *
 * Run it with LMStudio or Ollama serving a Qwen-class 7-8B instruct model:
 *
 *     OTTO_LOCAL_BASE_URL=http://127.0.0.1:1234/v1 npm run test:local
 *
 * Add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to measure the margin against
 * cloud. Without one, the violation-rate clause is still checked and the margin
 * is reported as not measured — never as passed.
 */

/** Where the run's numbers are written, so a later change has a baseline to move against. */
const REPORT = resolve(import.meta.dirname, "../baselines/extraction-metrics.json");

function localExtractor(): Extractor {
  const baseUrl = process.env.OTTO_LOCAL_BASE_URL;
  const model = process.env.OTTO_LOCAL_MODEL;
  return new LocalExtractor({
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
  });
}

/**
 * Whether a local runtime is actually serving, resolved once at module load so
 * the suite can `skipIf` on it — the convention the transcription measurements
 * already use, and the reason `npm run test:local` is runnable on a machine
 * that has not started LMStudio.
 */
async function localModelIsServing(): Promise<boolean> {
  const baseUrl = process.env.OTTO_LOCAL_BASE_URL ?? "http://127.0.0.1:1234/v1";
  try {
    return (await fetch(`${baseUrl}/models`)).ok;
  } catch {
    return false;
  }
}

const LOCAL_MISSING = "start LMStudio or Ollama and set OTTO_LOCAL_BASE_URL";

const serving = await localModelIsServing();

describe.skipIf(!serving)(`the local-extraction measurement (${LOCAL_MISSING})`, () => {
  it("clears the §6.3 floor, with the margin against cloud recorded as a number", async () => {
    const local = await runCorpus(localExtractor());
    const cloud = await runCloudWhereConfigured();
    const floor = checkFloor(local.metrics, cloud[0]?.metrics);

    // Reported before asserting, because a failed run's numbers are the whole
    // point of running it — `runtime.md` §2's response to a failure is a larger
    // minimum local model, and that call needs the data.
    // eslint-disable-next-line no-console
    console.log(
      [
        formatMetrics([local.metrics, ...cloud.map(({ metrics }) => metrics)]),
        "",
        formatFloor(floor),
        "",
        `Worst cases: ${failures(local)
          .slice(0, 8)
          .map(({ caseId }) => caseId)
          .join(", ")}`,
      ].join("\n"),
    );
    await writeReport(
      local.metrics,
      cloud.map(({ metrics }) => metrics),
      floor.accuracyMargin,
    );

    expect(floor.clauses.filter(({ cleared }) => !cleared)).toEqual([]);
  });
});

/** Each cloud provider whose key is present. An absent key is the ordinary case. */
async function runCloudWhereConfigured() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openAiKey = process.env.OPENAI_API_KEY;
  const extractors: Extractor[] = [
    ...(anthropicKey === undefined ? [] : [new AnthropicExtractor({ apiKey: anthropicKey })]),
    ...(openAiKey === undefined ? [] : [new OpenAiExtractor({ apiKey: openAiKey })]),
  ];
  return Promise.all(extractors.map((extractor) => runCorpus(extractor)));
}

/**
 * The run's numbers, written where a later run can be compared against them.
 *
 * `qa.md` §8's argument applies here as much as to the performance suite: every
 * bar passing by a wide margin means the bars alone will not catch a regression
 * until it is catastrophic, so what is watched is movement against the recorded
 * baseline rather than distance from the failure line.
 */
async function writeReport(
  local: ExtractionMetrics,
  cloud: readonly ExtractionMetrics[],
  accuracyMargin: number,
): Promise<void> {
  const report = {
    measuredAt: new Date().toISOString(),
    local,
    cloud,
    accuracyMargin: Number.isNaN(accuracyMargin) ? null : accuracyMargin,
  };
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
