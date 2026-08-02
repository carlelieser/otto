import type { ResolutionOutcome } from "../../src/inference/resolution/resolve-mention.js";

/**
 * Resolution accuracy and **bias direction as separate numbers**
 * (`qa.md` §6.1, Slice 4's verification).
 *
 * The separation is the whole point of this module. ADR-0007 and ADR-0009 both
 * bias resolution toward "none of these" over a wrong match, because a
 * duplicate is recoverable by merge and a misattribution quietly corrupts
 * knowledge. **An implementation that improved overall accuracy while shifting
 * errors from "none" toward "wrong match" would look better on a blended
 * metric and be worse for the product.** So there is no blended error rate
 * here, and adding one would defeat the instrument.
 */

/** What resolution should have done for one Mention, and what it did. */
export interface ResolutionCase {
  readonly caseId: string;
  /** The entity the Mention actually refers to, or `null` if it is genuinely new. */
  readonly expectedEntityId: string | null;
  readonly actualEntityId: string | null;
  readonly outcome: ResolutionOutcome;
  /** Whether the adjudicator was asked. Reported, never used to excuse an error. */
  readonly wasAdjudicated: boolean;
}

/**
 * The four ways one resolution can turn out.
 *
 * `wrong_match` and `missed_match` are the two error classes that must never be
 * averaged together — the first attaches a fact to the wrong entity, the second
 * creates a duplicate. `correct_match` and `correct_none` are the two successes,
 * kept apart for the same reason: a run that gets every "none" right and every
 * match wrong has a respectable blended accuracy.
 */
export const RESOLUTION_VERDICTS = [
  "correct_match",
  "correct_none",
  "wrong_match",
  "missed_match",
] as const;

export type ResolutionVerdict = (typeof RESOLUTION_VERDICTS)[number];

/** What one case turned out to be. */
export function verdictOf(resolutionCase: ResolutionCase): ResolutionVerdict {
  const { expectedEntityId, actualEntityId } = resolutionCase;
  if (expectedEntityId === null) {
    return actualEntityId === null ? "correct_none" : "wrong_match";
  }
  if (actualEntityId === null) return "missed_match";
  return actualEntityId === expectedEntityId ? "correct_match" : "wrong_match";
}

/** `qa.md` §6.1's resolution rows, with the two error classes never blended. */
export interface ResolutionMetrics {
  readonly cases: number;
  readonly verdicts: Readonly<Record<ResolutionVerdict, number>>;
  /** Right entity chosen among candidates, over the cases where one existed. */
  readonly matchAccuracy: number;
  /** Correctly declining to match, over the cases where nothing should match. */
  readonly noneAccuracy: number;
  /**
   * Wrong matches as a share of all errors, in [0, 1].
   *
   * **The number to watch.** The design accepts `missed_match` and refuses
   * `wrong_match`, so this rising is a regression even when overall accuracy
   * improves — which is exactly the trade a blended metric would hide.
   * Reported as `null` when there were no errors, rather than as 0: no errors
   * is not "no wrong matches among many."
   */
  readonly wrongMatchShareOfErrors: number | null;
  /** How often the adjudicator was invoked. It should be the minority path. */
  readonly adjudicationRate: number;
}

/** Every metric, computed from the cases. */
export function summariseResolution(cases: readonly ResolutionCase[]): ResolutionMetrics {
  const verdicts = countVerdicts(cases);
  const errors = verdicts.wrong_match + verdicts.missed_match;
  return {
    cases: cases.length,
    verdicts,
    matchAccuracy: ratio(verdicts.correct_match, verdicts.correct_match + verdicts.missed_match),
    noneAccuracy: ratio(verdicts.correct_none, verdicts.correct_none + wrongNones(cases)),
    wrongMatchShareOfErrors: errors === 0 ? null : verdicts.wrong_match / errors,
    adjudicationRate: ratio(
      cases.filter(({ wasAdjudicated }) => wasAdjudicated).length,
      cases.length,
    ),
  };
}

/** Cases that should have matched nothing and matched something anyway. */
function wrongNones(cases: readonly ResolutionCase[]): number {
  return cases.filter(
    (resolutionCase) =>
      resolutionCase.expectedEntityId === null && resolutionCase.actualEntityId !== null,
  ).length;
}

function countVerdicts(cases: readonly ResolutionCase[]): Record<ResolutionVerdict, number> {
  const counts = Object.fromEntries(RESOLUTION_VERDICTS.map((verdict) => [verdict, 0])) as Record<
    ResolutionVerdict,
    number
  >;
  for (const resolutionCase of cases) counts[verdictOf(resolutionCase)] += 1;
  return counts;
}

/** A rate, or 1 when there was nothing to be wrong about. */
function ratio(correct: number, total: number): number {
  return total === 0 ? 1 : correct / total;
}
