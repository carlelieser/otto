/**
 * What is to become of a Proposal.
 *
 * Three outcomes and no fourth: it applies without a human looking, it waits
 * for one, or it is dropped and recorded as dropped (`triage.md` §2).
 *
 * ## Why this lives in `domain/`
 *
 * A Disposition is not a number and not a score — it is the answer to "may this
 * happen to what I know without me looking?", which is a question about the
 * user's tolerance for damage rather than about Otto's machinery (ADR-0007).
 * Calibration proposes one from the numbers it keeps, and the application
 * policy may downgrade it, so both layers need the vocabulary; putting it here
 * is what lets `inference/` depend on `domain/` rather than the reverse.
 *
 * The order below is the ordering: index 0 is the most permissive. `atLeastAs`
 * reads it, which is what makes "may only downgrade, never upgrade" a property
 * of the type rather than a convention each call site has to remember.
 */
export const DISPOSITIONS = ["auto_apply", "needs_review", "discard"] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

/**
 * The more restrictive of the two.
 *
 * The whole of "may only downgrade" expressed once: a policy that returns
 * `mostRestrictive(proposed, itsOwnAnswer)` cannot upgrade whatever it decides,
 * because the proposed value is a ceiling on the result.
 */
export function mostRestrictive(left: Disposition, right: Disposition): Disposition {
  return restrictionOf(left) >= restrictionOf(right) ? left : right;
}

/** Whether `candidate` is no more permissive than `original`. */
export function isNoMorePermissiveThan(candidate: Disposition, original: Disposition): boolean {
  return restrictionOf(candidate) >= restrictionOf(original);
}

function restrictionOf(disposition: Disposition): number {
  return DISPOSITIONS.indexOf(disposition);
}
