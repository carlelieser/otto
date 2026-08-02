import { deriveProposalId } from "../../capture/capture-identity.js";
import { normalise } from "../../capture/normalise.js";
import type { Capture } from "../../ports/capture-store.js";
import type { Extraction, Extractor } from "../../ports/extractor.js";
import type { ExtractedProposal, ProposalStore } from "../../ports/proposal-store.js";
import type { Clock } from "./execute-command.js";

/** The stage these Proposals came from, and part of every `proposal_id`. */
const STAGE = "extraction";

/**
 * A stored Capture becomes Mentions and claimed values, recorded before the
 * next stage begins.
 *
 * Nothing is resolved to a real entity and nothing is written to knowledge: the
 * output is structure, not yet belief. Which entity a Mention refers to is a
 * different question with a different confidence behind it (Slice 4), and the
 * model never emits a Command at all.
 *
 * The stage is resumable, which `add.md` §4 requires of every stage and which
 * matters most here because this is the one that costs money. Recording output
 * against the Capture *before* the next stage begins means a crash after
 * extraction resumes at resolution rather than re-invoking the extractor.
 */
export class CaptureExtraction {
  readonly #extractor: Extractor;
  readonly #proposals: ProposalStore;
  readonly #now: Clock;

  constructor(extractor: Extractor, proposals: ProposalStore, now: Clock) {
    this.#extractor = extractor;
    this.#proposals = proposals;
    this.#now = now;
  }

  /**
   * The Proposals for this Capture, extracting only if it has none.
   *
   * The check comes first and is the whole of the resumability guarantee: a
   * Capture whose Proposals are already recorded returns them without calling
   * the model, so a worker restarted after a crash carries on rather than
   * re-billing a call whose result is already durable.
   *
   * Asking the store rather than tracking a per-stage status flag keeps the
   * resumption point derivable from what is stored, in the same way the startup
   * sweep's anti-join needs no bookkeeping of its own. A status column is a
   * second truth that can disagree with the rows it describes.
   */
  async extract(capture: Capture): Promise<readonly ExtractedProposal[]> {
    const recorded = await this.#proposals.forCapture(capture.captureId);
    if (recorded.length > 0) return recorded;

    const extraction = await this.#extractor.extract(this.#requestFor(capture));
    return this.#proposals.put(this.#asProposals(capture, extraction));
  }

  /**
   * The text and the timestamp, and deliberately nothing else.
   *
   * The corrected transcript wins where Slice 9 has written one: the user has
   * said the raw text was wrong, and extracting from what they corrected is the
   * point of correcting it (`add.md` §5.1). Normalised on read rather than read
   * from a column, because a stored normalised copy is a second truth that can
   * disagree with the first.
   */
  #requestFor(capture: Capture): { text: string; capturedAt: string } {
    return {
      text: normalise(capture.correctedText ?? capture.rawText),
      capturedAt: capture.sourceTimestamp,
    };
  }

  /** One Proposal per Mention, each with its id derived from its ordinal. */
  #asProposals(capture: Capture, extraction: Extraction): ExtractedProposal[] {
    const { provider, modelVersion } = extraction;
    const extractedAt = this.#now();
    const captureId = capture.captureId;
    return extraction.mentions.map((mention, ordinal) => ({
      proposalId: proposalIdFor(captureId, extraction, ordinal),
      captureId,
      mention,
      provider,
      modelVersion,
      extractedAt,
    }));
  }
}

/**
 * `runtime.md` §3's derivation, with this stage's name supplied.
 *
 * `ordinal` is what keeps two Mentions from one Capture, one model, and one
 * stage from colliding; the provider and model version are what let a re-run
 * under a *better* model produce new Proposals rather than no-ops.
 */
function proposalIdFor(captureId: string, extraction: Extraction, ordinal: number): string {
  const { provider, modelVersion } = extraction;
  return deriveProposalId({ captureId, stage: STAGE, provider, modelVersion, ordinal });
}
