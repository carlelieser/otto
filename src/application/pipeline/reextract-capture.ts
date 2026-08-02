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
 *
 * ## What this stage stops short of
 *
 * It re-runs **extraction**, not the whole pipeline. Resolution, the differ,
 * and triage are not reachable from here and are not invoked — **there is no
 * pipeline driver in Otto yet**, and triage has been wired and undriven since
 * Slice 5 (`composition-root.ts`). So `emerged` reports which Proposals are new
 * and does not close anything: closing a Proposal against current state is
 * `repropose.ts`'s `no_change`, which runs from the differ and needs the driver
 * that does not exist.
 *
 * Under the same model nothing is new, so nothing *would* reach a queue —
 * which is the outcome `runtime.md` §3 describes, arrived at because the ids
 * collided rather than because anything was adjudicated and closed. Saying so
 * beats a comment implying this stage already satisfies §3's closure rule.
 */
export class CaptureReextraction {
  readonly #extraction: CaptureExtraction;
  readonly #proposals: ProposalStore;

  constructor(extraction: CaptureExtraction, proposals: ProposalStore) {
    this.#extraction = extraction;
    this.#proposals = proposals;
  }

  /**
   * Re-runs extraction, reporting what it produced and which of it is new.
   *
   * One method rather than three. Both answers come from one model call, and
   * splitting them into separate reads would either call the model twice for a
   * single correction or leave a caller to remember not to.
   *
   * `emerged` is a subtraction **by id**, not a comparison of claimed values.
   * Under the same model the ids collide, the store no-ops, and the set is
   * empty — a re-run that confirms what Otto already extracted has nothing new
   * to say. Under a different model version the ids differ and everything is
   * new, which is the other half of `runtime.md` §3.
   */
  async reextract(capture: Capture): Promise<ReextractionOutcome> {
    const before = await this.#proposals.forCapture(capture.captureId);
    const recorded = new Set(before.map((proposal) => proposal.proposalId));
    const proposals = await this.#extraction.reextract(capture);
    return { proposals, emerged: proposals.filter((it) => !recorded.has(it.proposalId)) };
  }
}

/** What a re-run produced, and which of it is new. */
export interface ReextractionOutcome {
  /** Everything the current text extracted, whether or not it is new. */
  readonly proposals: readonly ExtractedProposal[];
  /** The subset no earlier run had recorded. Empty when the re-run confirmed. */
  readonly emerged: readonly ExtractedProposal[];
}
