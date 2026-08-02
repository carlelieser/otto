import type { Extractor } from "../../src/ports/extractor.js";
import type { EvalCase } from "./corpus/case.js";
import { EVAL_CORPUS } from "./corpus/notes.js";
import { type ExtractionMetrics, summarise } from "./metrics.js";
import { type CaseScore, scoreCase } from "./score.js";

/**
 * The corpus run: every case through one extractor, scored into `qa.md` §6.1's
 * metrics.
 *
 * One function for every provider, which is what makes the local-vs-cloud
 * margin a comparison rather than two separate measurements taken differently.
 * The corpus, the scorer, and the metric definitions are shared; only the
 * adapter changes.
 */
export async function runCorpus(
  extractor: Extractor,
  cases: readonly EvalCase[] = EVAL_CORPUS,
): Promise<CorpusRun> {
  const scores: CaseScore[] = [];
  let provider = "unknown";
  let modelVersion = "unknown";

  for (const evalCase of cases) {
    const extraction = await extractor.extract({
      text: evalCase.note,
      capturedAt: evalCase.capturedAt,
    });
    ({ provider, modelVersion } = extraction);
    scores.push(scoreCase(evalCase, extraction));
  }

  return { scores, metrics: summarise(scores, provider, modelVersion) };
}

export interface CorpusRun {
  /** Per case, so a regression names the note it broke on. */
  readonly scores: readonly CaseScore[];
  readonly metrics: ExtractionMetrics;
}

/**
 * The cases a run got wrong, worst first.
 *
 * The metrics say how well a model did; this says on what. A recall drop of two
 * points is a number, and "it stopped finding the second Sarah" is a bug
 * report.
 */
export function failures(run: CorpusRun): readonly CaseScore[] {
  return run.scores
    .filter((score) => errorCount(score) > 0)
    .sort((left, right) => errorCount(right) - errorCount(left));
}

function errorCount(score: CaseScore): number {
  return (
    score.mentionsMissed +
    score.mentionsInvented +
    score.fieldsWrong +
    score.datesWrong +
    score.precisionWrong +
    score.violations
  );
}
