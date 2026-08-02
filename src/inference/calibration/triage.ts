import { CLEAR_FIELD, CREATE_ENTITY, RELATE } from "../../domain/commands/knowledge-commands.js";
import { type ChangeKind, permittedDisposition } from "../../domain/policies/application-policy.js";
import { type Disposition, mostRestrictive } from "../../domain/policies/disposition.js";
import { findField } from "../../domain/schema/entity-schema.js";
import type { Proposal } from "../../ports/proposal.js";
import { type CalibrationState, cappedExtraction, isWithheldByBootstrap } from "./bootstrap.js";
import { combineConfidence } from "./confidence.js";
import { type Draw, isSampled } from "./sampling.js";
import { bandFor, thresholdsFor } from "./thresholds.js";

/**
 * **Where a Proposal becomes a decision** (`triage.md`, `add.md` §5.5).
 *
 * Four things happen here in one direction, and the direction is the design:
 *
 * 1. The two Confidences combine into one, under this model's bootstrap cap.
 * 2. That number falls in a band, giving a *proposed* Disposition.
 * 3. The domain policy is asked about the **kind of change** and may downgrade
 *    it. It never sees a number, and it may never upgrade (ADR-0007).
 * 4. Sampling may downgrade an `auto_apply` once more, and marks it.
 *
 * Nothing in this file writes anything. Triage is a pure function of a Proposal
 * and the calibration state, which is what lets the whole of `qa.md` §5 run
 * with no fixtures.
 *
 * ## Why the band is returned alongside the decision
 *
 * `bandDisposition` is what the numbers alone said, before the policy and
 * sampling had their turn. It is carried out so "control flows one way" is a
 * property something can *check* rather than a claim this comment makes — and
 * so the review queue can later say why a confident proposal is sitting in it.
 */

/** What triage decided, and enough of its reasoning to answer for it. */
export interface TriagedProposal {
  readonly proposal: Proposal;
  /** The decision: what actually happens to this Proposal. */
  readonly disposition: Disposition;
  /** What the numbers alone said, before the policy and sampling narrowed it. */
  readonly bandDisposition: Disposition;
  /** `p(correct)`, the combined number the band was read from. */
  readonly confidence: number;
  /**
   * Whether calibration sampling pulled this out of auto-apply.
   *
   * A plain flag with nothing a surface could render. `triage.md` §6 requires
   * sampled proposals to appear in the review queue indistinguishably from
   * ordinary ones — a label or a reason here would be the thing that leaks into
   * the UI and biases the adjudication it exists to measure.
   */
  readonly wasSampled: boolean;
}

/** What triage needs beyond the Proposal: how much has been measured, and a draw. */
export interface TriageContext {
  /** Corrections for this Proposal's provider and model version (ADR-0008). */
  readonly correctionCount: number;
  /** The sampling draw. A seam for tests, never a way to turn sampling off. */
  readonly draw?: Draw;
}

/** The Disposition this Proposal receives, and the reasoning behind it. */
export function triage(proposal: Proposal, context: TriageContext): TriagedProposal {
  const state = calibrationStateFor(proposal, context);
  const confidence = confidenceOf(proposal, state);
  const bandDisposition = bandFor(confidence, state.thresholds);
  const decided = decide(proposal, bandDisposition, state);

  return { proposal, confidence, bandDisposition, ...sampledIfConfident(decided, state, context) };
}

/** The bootstrap cap and the thresholds this Proposal's own model is triaged against. */
function calibrationStateFor(proposal: Proposal, context: TriageContext): CalibrationState {
  return {
    correctionCount: context.correctionCount,
    thresholds: thresholdsFor(proposal.model),
  };
}

/** `p(correct)`, with `p(extraction)` capped while the model is unmeasured. */
function confidenceOf(proposal: Proposal, state: CalibrationState): number {
  const { extraction, resolution } = proposal.confidences;
  return combineConfidence({ extraction: cappedExtraction(extraction, state), resolution });
}

/**
 * The band, narrowed by bootstrap and then by the domain policy.
 *
 * Both are downgrades and both go through `mostRestrictive`, so neither can
 * widen what the numbers gave — which is the one-way flow `add.md` §5.5 asks
 * for, expressed as arithmetic rather than as a convention.
 */
function decide(proposal: Proposal, band: Disposition, state: CalibrationState): Disposition {
  const withheld = isWithheldByBootstrap(proposal.confidences, state) ? "needs_review" : band;
  return permittedDisposition(mostRestrictive(band, withheld), changeKindOf(proposal));
}

/**
 * Sampling's downgrade, applied last and only to what would otherwise apply
 * unattended.
 *
 * Only `auto_apply` is sampled, because sampling exists to measure the
 * auto-apply band. Marking a proposal that was already heading for review would
 * put an unsampled adjudication into the sampled population, which is the one
 * thing that would make the measurement worse than not having it.
 */
function sampledIfConfident(
  disposition: Disposition,
  state: CalibrationState,
  context: TriageContext,
): { disposition: Disposition; wasSampled: boolean } {
  if (disposition !== "auto_apply") return { disposition, wasSampled: false };
  if (!isSampled(state, context.draw)) return { disposition, wasSampled: false };
  return { disposition: "needs_review", wasSampled: true };
}

/**
 * The kind of change a Command represents, in the vocabulary the domain policy
 * speaks.
 *
 * **This is the translation layer, and it is deliberately in `inference/`.**
 * The policy is asked about a kind of change; deciding that a `ClearField` *is*
 * a removal is a fact about Otto's Command vocabulary rather than about the
 * user's tolerance for damage, so it sits on this side of the boundary.
 */
export function changeKindOf(proposal: Proposal): ChangeKind {
  const { command, resolution, entityType } = proposal;
  if (command.type === CREATE_ENTITY) {
    return {
      change: "create",
      hadRejectedCandidates: resolution.outcome === "rejected_candidates",
    };
  }
  if (command.type === RELATE) return { change: "add_relation" };
  if (command.type === CLEAR_FIELD) return { change: "remove" };
  return { change: "update_field", floor: floorOf(command, entityType) };
}

/**
 * The field's floor, read from `schema.md` rather than listed here.
 *
 * An unknown field falls to `review` rather than to `auto`. It should be
 * structurally impossible — the differ builds Commands against the schema — but
 * the safe direction for a case that should not happen is the one where a human
 * looks at it.
 */
function floorOf(
  command: Proposal["command"],
  entityType: Proposal["entityType"],
): "auto" | "review" {
  const { field } = command.payload as { field?: string };
  if (field === undefined) return "review";
  return findField(entityType, field)?.floor ?? "review";
}
