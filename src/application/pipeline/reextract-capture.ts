import type { Capture } from "../../ports/capture-store.js";
import type { ExtractedProposal, ProposalStore } from "../../ports/proposal-store.js";
import type { CaptureExtraction } from "./extract-capture.js";

/**
 * **Extraction run again for a Capture whose input changed** (`runtime.md` §3,
 * §5).
 *
 * `CaptureExtraction.extract` returns recorded Proposals without calling the
 * model, which is the resumability guarantee that keeps a restarted worker from
 * re-billing a call. That guarantee is exactly what a correction has to get
 * past: the recorded Proposals were extracted from the misheard text, and
 * returning them is the bug this stage exists to prevent.
 *
 * ## It does not delete the old Proposals
 *
 * A Proposal is a claim that was made, and re-extraction is not a rewrite of
 * what Otto once considered. Under the same model the ids collide and the store
 * no-ops (`runtime.md` §3); under a different model version the ids differ and
 * both sets stand, with the new ones arriving as ordinary Proposals subject to
 * ordinary triage.
 *
 * ## Re-extraction is otherwise manual
 *
 * Correcting a transcript is **the one case where this runs automatically**,
 * because the user has explicitly said the input was wrong (`runtime.md` §3).
 * Everywhere else it is an explicit action over a selected range — silently
 * re-processing history when a model changes would flood the review queue and
 * re-litigate settled knowledge. Nothing here schedules itself, which is what
 * keeps that distinction a property of the callers rather than of this class.
 */
export class CaptureReextraction {
  readonly #extraction: CaptureExtraction;
  readonly #proposals: ProposalStore;

  constructor(extraction: CaptureExtraction, proposals: ProposalStore) {
    this.#extraction = extraction;
    this.#proposals = proposals;
  }

  /**
   * The Proposals this Capture's *current* text produces, extracting afresh.
   *
   * Everything the run produced, including Proposals that were already
   * recorded — `emerged` is what separates the two, and a caller that wants
   * only the differences asks for that instead.
   */
  async reextract(capture: Capture): Promise<readonly ExtractedProposal[]> {
    return this.#extraction.reextract(capture);
  }

  /**
   * The Proposals a re-run produces that were **not already recorded**.
   *
   * Under the same model this is empty: the ids collide, the store no-ops, and
   * a re-run confirming what Otto already extracted has nothing new to say.
   * That emptiness is what `runtime.md` §3's silent closure rests on one stage
   * later — nothing reaches the queue because nothing new was proposed.
   *
   * Under a different model version the ids differ and every Proposal is new,
   * which is the other half of §3 and the reason this is a subtraction by id
   * rather than a comparison of claimed values.
   */
  async emerged(capture: Capture): Promise<readonly ExtractedProposal[]> {
    const before = await this.#proposals.forCapture(capture.captureId);
    const recorded = new Set(before.map((proposal) => proposal.proposalId));
    const produced = await this.reextract(capture);
    return produced.filter((proposal) => !recorded.has(proposal.proposalId));
  }
}
