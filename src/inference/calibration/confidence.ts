import type { SeparateConfidences } from "../../ports/proposal.js";

/**
 * The one place `p(extraction)` and `p(resolution)` are allowed to meet
 * (`triage.md` §1).
 *
 * ```
 * p(correct) = p(extraction) × p(resolution)   -- when both apply
 * p(correct) = p(extraction)                   -- creates, and field changes
 *                                                 on an already-resolved entity
 * ```
 *
 * ## Why a product, given that it is wrong
 *
 * Multiplication treats the two as independent, which they are not — a Capture
 * whose text was misread tends to resolve badly too — so the product
 * systematically underestimates. ADR-0012 chose it over the minimum for exactly
 * that reason: the minimum discards the second signal entirely, and two
 * independent 0.9s should not score the same as a 0.9 and a 0.95. The
 * underestimate is the point, and it points where every other decision in
 * triage points, which is toward review.
 *
 * `null` resolution is not the same as a resolution of 1. It means no
 * resolution judgement was made — a create has no candidate it was chosen over
 * — and multiplying by an invented 1 would be an implementation detail
 * masquerading as a measurement.
 */
export function combineConfidence(confidences: SeparateConfidences): number {
  const { extraction, resolution } = confidences;
  if (resolution === null) return extraction;
  return extraction * resolution;
}
