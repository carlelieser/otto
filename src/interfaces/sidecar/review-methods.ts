import type { ProposalAdjudication } from "../../application/pipeline/adjudicate-proposal.js";
import type { DuplicateDetection } from "../../application/pipeline/detect-duplicates.js";
import type { BootstrapStatus } from "../../application/surface/read-bootstrap-status.js";
import type { ReviewQueue } from "../../application/surface/read-review-queue.js";
import type { Command } from "../../domain/commands/command.js";
import { isCounterfactual } from "../../domain/knowledge/correction.js";
import type { ModelIdentity } from "../../ports/proposal.js";
import type { Methods } from "./dispatch.js";

/**
 * The review queue over the transport (`add.md` §7, PRD §5.4).
 *
 * Reads and adjudications, which is everything the queue surface does. There is
 * deliberately **no method that acts on a discard**: `listDiscards` returns
 * entries carrying no Command, and nothing here would apply one if it did.
 * Making discards actionable would turn the low band into a second review
 * queue, which is what the threshold exists to prevent (`triage.md` §7).
 */
export function reviewMethods(
  queue: ReviewQueue,
  adjudication: ProposalAdjudication,
  bootstrap: BootstrapStatus,
  duplicates?: DuplicateDetection,
): Methods {
  return {
    listAwaitingReview: () => queue.awaitingReview(),
    listAppliedRecords: () => queue.appliedRecords(),
    listDiscards: (params) => queue.discards(requireAsOf(params)),
    confirmProposal: (params) => adjudication.confirm(requireProposalId(params)),
    correctProposal: (params) => correctProposal(params, adjudication),
    bootstrapStatus: (params) => bootstrap.forModel(requireModel(params)),
    ...duplicateMethods(duplicates),
  };
}

/**
 * The duplicate sweep, when there is one wired.
 *
 * It returns the pairs it queued rather than nothing, so a caller can show "3
 * suspected duplicates found" without a second read — and so a sweep that found
 * nothing is distinguishable from one that did not run.
 *
 * **There is no method here that merges.** The sweep queues entries and
 * `confirmProposal` is what applies one, which is the same path every other
 * proposal takes. A `mergeEntities` method on this transport would be a way to
 * merge without a user having confirmed anything, at any confidence, which is
 * exactly what ADR-0007 forbids.
 */
function duplicateMethods(duplicates?: DuplicateDetection): Methods {
  if (duplicates === undefined) return {};
  return { sweepDuplicates: () => duplicates.sweep() };
}

/**
 * Corrects a Proposal to the Command the user chose.
 *
 * The chosen Command is validated at this boundary rather than trusted, because
 * a correction whose counterfactual did not survive the trip is the rejection
 * flag ADR-0006 exists to prevent, wearing the right type name.
 */
async function correctProposal(params: unknown, adjudication: ProposalAdjudication) {
  const proposalId = requireProposalId(params);
  return adjudication.correct(proposalId, requireChosen(params));
}

function requireProposalId(params: unknown): string {
  const { proposalId } = (params ?? {}) as { proposalId?: unknown };
  if (typeof proposalId !== "string" || proposalId === "") {
    throw new Error("this method requires a proposalId");
  }
  return proposalId;
}

/**
 * The instant the retention window is measured against.
 *
 * Required rather than defaulted to the sidecar's clock, for the reason
 * `DispositionStore.discards` takes it: "present at 29 days, absent after 30"
 * is not a thing a caller can assert against a surface that decides for itself
 * what time it is.
 */
function requireAsOf(params: unknown): string {
  const { asOf } = (params ?? {}) as { asOf?: unknown };
  if (typeof asOf !== "string" || asOf === "") throw new Error("listDiscards requires asOf");
  return asOf;
}

/**
 * The Command the user chose instead — the counterfactual, checked for shape.
 *
 * The check is `isCounterfactual`'s rather than a local one. What makes a
 * counterfactual valid is a question about corrections (ADR-0006), and a second
 * copy of the answer at the transport is one that drifts from the first.
 */
function requireChosen(params: unknown): Command {
  const { chosen } = (params ?? {}) as { chosen?: unknown };
  if (!isCounterfactual(chosen)) {
    throw new Error("correctProposal requires the chosen Command the user picked instead");
  }
  return chosen;
}

/** The provider and model version bootstrap status is reported for (ADR-0008). */
function requireModel(params: unknown): ModelIdentity {
  const { provider, modelVersion } = (params ?? {}) as Partial<ModelIdentity>;
  if (typeof provider !== "string" || typeof modelVersion !== "string") {
    throw new Error("bootstrapStatus requires a provider and modelVersion");
  }
  return { provider, modelVersion };
}
