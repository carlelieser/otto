import { isNonEmptyText } from "./text.js";

/**
 * Where a piece of knowledge came from: which Capture, which Proposal, which
 * model and version, at what Confidence, and whether a human confirmed it
 * (`add.md` §10).
 *
 * Provenance is a record *about* Otto's machinery, not a property of
 * knowledge, and that is what lets it carry a Confidence at all. ADR-0002's
 * rule is that knowledge never carries one — a Confidence on anything
 * past-tense means two concepts got merged. The number here is frozen at the
 * moment of inference and describes the inference, never how true the
 * knowledge is now.
 *
 * ADR-0006: provenance not recorded at write time is unreconstructable later,
 * so every field is required. A human-confirmed record has no inference to
 * describe, which `humanConfirmedProvenance` expresses with a null Confidence.
 */
export interface Provenance {
  /** The Proposal that produced the change, absent when a human issued it directly. */
  readonly proposalId: string | null;
  /** The Capture everything ultimately traces back to. */
  readonly captureId: string;
  /** The inference provider, e.g. a local runtime or a named vendor. */
  readonly provider: string;
  /** Triage thresholds are keyed by this alongside the provider (ADR-0008). */
  readonly modelVersion: string;
  /**
   * What the machinery reported at the time of inference, in [0, 1].
   * `null` when no inference was involved, as for a human-issued change.
   */
  readonly confidence: number | null;
  /** Whether a human confirmed this change rather than it applying unattended. */
  readonly isHumanConfirmed: boolean;
}

const CONFIDENCE_RANGE = { minimum: 0, maximum: 1 } as const;

/** The provider recorded when a human, not a model, is the source of a change. */
export const HUMAN_PROVIDER = "human";

/**
 * Provenance for a change a human made directly, bypassing inference.
 * Adjudicating from the review queue issues a Command to the executor without
 * re-entering the pipeline (`add.md` §7), so there is no model to name.
 */
export function humanConfirmedProvenance(captureId: string, proposalId: string | null): Provenance {
  return {
    proposalId,
    captureId,
    provider: HUMAN_PROVIDER,
    modelVersion: HUMAN_PROVIDER,
    confidence: null,
    isHumanConfirmed: true,
  };
}

/**
 * The record in a fixed field order, for comparing two of them.
 *
 * Serialising a provenance record is a question about this shape, so it is
 * answered here rather than wherever a comparison happens to be needed. A
 * caller writing the six fields out itself is a second declaration that drifts
 * the first time this one gains a field — and it would have to name a
 * Confidence to do it, which `add.md` §3's fourth rule reserves to this module.
 *
 * The order is the declaration's, so a field added above is a field that
 * appears in the middle rather than at the end. Nothing parses the output, so
 * only its stability within one run matters.
 */
export function canonicalProvenance(provenance: Provenance): Record<string, unknown> {
  return {
    proposalId: provenance.proposalId,
    captureId: provenance.captureId,
    provider: provenance.provider,
    modelVersion: provenance.modelVersion,
    confidence: provenance.confidence,
    isHumanConfirmed: provenance.isHumanConfirmed,
  };
}

/** Every field of `provenance`, or the names of those that are missing or invalid. */
export function provenanceViolations(provenance: Provenance): readonly string[] {
  return [...missingRequiredFields(provenance), ...confidenceViolations(provenance)];
}

const REQUIRED_TEXT_FIELDS = ["captureId", "provider", "modelVersion"] as const;

function missingRequiredFields(provenance: Provenance): string[] {
  return REQUIRED_TEXT_FIELDS.filter((field) => !isNonEmptyText(provenance[field]));
}

function confidenceViolations(provenance: Provenance): string[] {
  const { confidence } = provenance;
  if (confidence === null) return [];
  const isInRange =
    confidence >= CONFIDENCE_RANGE.minimum && confidence <= CONFIDENCE_RANGE.maximum;
  return isInRange ? [] : ["confidence"];
}
