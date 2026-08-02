import type { CaseScore } from "./score.js";

/**
 * `qa.md` §6.1's metric table, computed from case scores.
 *
 * Reported per provider and model version, which is what makes the local-vs-
 * cloud margin a number rather than an impression — and what ADR-0008's
 * per-model thresholds need, since a confidence of 0.8 from a local Qwen is not
 * the same number as 0.8 from Claude.
 */
export interface ExtractionMetrics {
  readonly provider: string;
  readonly modelVersion: string;
  readonly cases: number;
  /** Of the entities the corpus expects, the fraction found. */
  readonly mentionRecall: number;
  /** Of the entities returned, the fraction the corpus expected. */
  readonly mentionPrecision: number;
  /** Right entity, right value. */
  readonly fieldValueAccuracy: number;
  /** Relative dates resolved to the right instant. */
  readonly dateResolutionAccuracy: number;
  /** "next quarter" marked `quarter`, not `exact`. */
  readonly datePrecisionAccuracy: number;
  /**
   * The fraction of emitted fields that were dropped as unknown or derived.
   *
   * **Zero-tolerance** (`qa.md` §6.1). Grammar constraints should guarantee it
   * on the local path, and `qa.md` §6.3 is explicit that a non-zero rate means
   * the constraint is misconfigured rather than the model being weak.
   *
   * A rate of *fields*, not of cases: §6.1 names it as a rate of "fields not in
   * `schema.md`", and dividing by cases gives violations-per-note, which can
   * exceed 1 and makes a bar written as a fraction far weaker than it reads.
   */
  readonly schemaViolationRate: number;
  /**
   * The mean `p(extraction)` the model reported across the mentions it returned.
   *
   * Not a quality metric — it is what the model *claimed*, and ADR-0006's
   * argument is that a self-reported LLM confidence is a token distribution
   * rather than a probability. It is reported because `qa.md` §6.3's
   * degradation clause is a statement about it: the intended degradation is
   * lower confidence and therefore more review, so a weak model reporting the
   * same confidence as a strong one is the failure rather than the success.
   */
  readonly meanConfidence: number;
}

export function summarise(
  scores: readonly CaseScore[],
  provider: string,
  modelVersion: string,
): ExtractionMetrics {
  const total = totals(scores);
  return {
    provider,
    modelVersion,
    cases: scores.length,
    mentionRecall: ratio(total.mentionsFound, total.mentionsFound + total.mentionsMissed),
    mentionPrecision: ratio(total.mentionsFound, total.mentionsFound + total.mentionsInvented),
    fieldValueAccuracy: ratio(total.fieldsCorrect, total.fieldsCorrect + total.fieldsWrong),
    dateResolutionAccuracy: ratio(total.datesCorrect, total.datesCorrect + total.datesWrong),
    datePrecisionAccuracy: ratio(
      total.precisionCorrect,
      total.precisionCorrect + total.precisionWrong,
    ),
    schemaViolationRate: errorRatio(total.violations, total.fieldsEmitted),
    // Zero when nothing was returned: a model that claimed nothing did not
    // claim certainty, and `ratio`'s empty-denominator 1 would read as exactly
    // that.
    meanConfidence: errorRatio(total.confidenceSum, total.mentionsReturned),
  };
}

type Totals = Record<Exclude<keyof CaseScore, "caseId">, number>;

const EMPTY: Totals = {
  mentionsFound: 0,
  mentionsMissed: 0,
  mentionsInvented: 0,
  fieldsCorrect: 0,
  fieldsWrong: 0,
  datesCorrect: 0,
  datesWrong: 0,
  precisionCorrect: 0,
  precisionWrong: 0,
  violations: 0,
  fieldsEmitted: 0,
  confidenceSum: 0,
  mentionsReturned: 0,
};

function totals(scores: readonly CaseScore[]): Totals {
  return scores.reduce<Totals>((carried, score) => {
    const summed = { ...carried };
    for (const key of Object.keys(EMPTY) as (keyof Totals)[]) summed[key] += score[key];
    return summed;
  }, EMPTY);
}

/**
 * An accuracy, with an empty denominator reported as 1 rather than as `NaN`.
 *
 * A corpus subset with no dates in it has not failed date resolution, and a
 * `NaN` propagating into a comparison would silently make every margin
 * unreadable.
 *
 * Only for metrics where more is better. An *error* rate with no denominator is
 * `errorRatio`'s job: reporting "nothing emitted" as 100% violations would fail
 * the floor on a model that produced nothing at all, which is a recall failure
 * rather than a schema one.
 */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

/** A rate where more is worse, so an empty denominator is 0 rather than 1. */
function errorRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** The metric table as a fixed-width report, for a CI log or a decision record. */
export function formatMetrics(metrics: readonly ExtractionMetrics[]): string {
  const header =
    "provider/model                  recall  prec.   field   date    dateprec  conf.   viol.";
  return [header, ...metrics.map(formatRow)].join("\n");
}

function formatRow(metrics: ExtractionMetrics): string {
  const name = `${metrics.provider}/${metrics.modelVersion}`.padEnd(30);
  return [
    name,
    percent(metrics.mentionRecall),
    percent(metrics.mentionPrecision),
    percent(metrics.fieldValueAccuracy),
    percent(metrics.dateResolutionAccuracy),
    percent(metrics.datePrecisionAccuracy).padEnd(8),
    percent(metrics.meanConfidence),
    metrics.schemaViolationRate.toFixed(3),
  ].join("  ");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`.padEnd(6);
}
