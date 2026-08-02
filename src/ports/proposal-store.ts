import type { Mention } from "./extractor.js";

/**
 * Where a stage's output is recorded against its Capture before the next stage
 * begins (`add.md` §4).
 *
 * This is what makes the pipeline resumable per stage rather than per Capture.
 * A crash mid-extraction leaves a Capture with no Proposals, which the worker
 * picks up on restart; a crash *after* extraction leaves Proposals the next
 * stage resumes from, so the restart does not re-invoke the extractor and does
 * not re-bill the call.
 *
 * Separate from `EventStore` because a Proposal is not a change to knowledge.
 * It is a claim awaiting triage, and most of them never become events at all —
 * a discarded Proposal is recorded and never applied (`add.md` §5.5). Putting
 * them in the log would make the log a record of what Otto considered rather
 * than of what changed.
 */
export interface ProposalStore {
  /**
   * Records extraction's output for a Capture, returning it as stored.
   *
   * Re-recording an existing `proposalId` is a no-op that returns what is
   * stored, matching `EventStore.append` and `CaptureStore.put` — a storage
   * port that throws where its siblings no-op means every caller has to learn
   * which is which. That is what makes a retried extraction under the same
   * model produce one Proposal rather than two (`runtime.md` §3).
   */
  put(proposals: readonly ExtractedProposal[]): Promise<readonly ExtractedProposal[]>;

  /**
   * Every Proposal extraction recorded for this Capture, in the order it
   * emitted them.
   *
   * The resumption query: a non-empty result means extraction already ran and
   * the worker should carry on to resolution rather than call the model again.
   */
  forCapture(captureId: string): Promise<readonly ExtractedProposal[]>;
}

/**
 * One Mention and its claimed values, recorded against the Capture that
 * produced it.
 *
 * Extraction's output, not the differ's: nothing here names an entity or a
 * Command. Which entity this Mention refers to is Slice 4's question, and the
 * model never emits a Command at all — that is where hallucination is
 * structurally prevented (`add.md` §5.4).
 */
export interface ExtractedProposal {
  /**
   * `hash(captureId, stage, provider, modelVersion, ordinal)` per `runtime.md`
   * §3, derived by `deriveProposalId`.
   *
   * The provider and model version are in the hash on purpose: a retry under
   * the same model is a no-op, and a re-run under a better model produces new
   * Proposals rather than colliding with the old ones.
   */
  readonly proposalId: string;
  readonly captureId: string;
  readonly mention: Mention;
  /** The adapter that produced it. Triage thresholds key on this pair (ADR-0008). */
  readonly provider: string;
  readonly modelVersion: string;
  /** When the row was written, ISO 8601. */
  readonly extractedAt: string;
}
