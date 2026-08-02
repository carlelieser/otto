import type { Mention } from "../../ports/extractor.js";
import type { ExtractedProposal } from "../../ports/proposal-store.js";

/** An `extraction_proposals` row as SQLite returns it. */
export interface ProposalRow {
  readonly proposal_id: string;
  readonly capture_id: string;
  readonly ordinal: number;
  /** The Mention as JSON — read whole by the next stage, never queried by field. */
  readonly mention: string;
  readonly provider: string;
  readonly model_version: string;
  readonly extracted_at: string;
}

/**
 * The bound parameters an insert needs.
 *
 * `ordinal` is passed in rather than read off the Proposal because it is a
 * property of the *position*, not of the Proposal: it is already folded into
 * `proposal_id` (`runtime.md` §3), and storing it again as a column would be a
 * second copy that a re-ordered write could make disagree with the id.
 */
export function toInsertParameters(
  proposal: ExtractedProposal,
  ordinal: number,
): Record<string, unknown> {
  return {
    proposal_id: proposal.proposalId,
    capture_id: proposal.captureId,
    ordinal,
    mention: JSON.stringify(proposal.mention),
    provider: proposal.provider,
    model_version: proposal.modelVersion,
    extracted_at: proposal.extractedAt,
  };
}

/** A row rebuilt into the Proposal it was stored from. */
export function toProposal(row: ProposalRow): ExtractedProposal {
  return {
    proposalId: row.proposal_id,
    captureId: row.capture_id,
    mention: JSON.parse(row.mention) as Mention,
    provider: row.provider,
    modelVersion: row.model_version,
    extractedAt: row.extracted_at,
  };
}
