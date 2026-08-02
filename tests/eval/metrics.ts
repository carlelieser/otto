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
   * Fields dropped as unknown or derived, per case.
   *
   * **Zero-tolerance** (`qa.md` §6.1). Grammar constraints should guarantee it
   * on the local path, and `qa.md` §6.3 is explicit that a non-zero rate means
   * the constraint is misconfigured rather than the model being weak.
   */
  readonly schemaViolationRate: number;
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
    schemaViolationRate: ratio(total.violations, scores.length),
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
};

function totals(scores: readonly CaseScore[]): Totals {
  return scores.reduce<Totals>((carried, score) => {
    const summed = { ...carried };
    for (const key of Object.keys(EMPTY) as (keyof Totals)[]) summed[key] += score[key];
    return summed;
  }, EMPTY);
}

/**
 * A rate, with an empty denominator reported as 1 rather than as `NaN`.
 *
 * A corpus subset with no dates in it has not failed date resolution, and a
 * `NaN` propagating into a comparison would silently make every margin
 * unreadable.
 */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

/** The metric table as a fixed-width report, for a CI log or a decision record. */
export function formatMetrics(metrics: readonly ExtractionMetrics[]): string {
  const header = "provider/model                  recall  prec.   field   date    dateprec  viol.";
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
    metrics.schemaViolationRate.toFixed(3),
  ].join("  ");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`.padEnd(6);
}
