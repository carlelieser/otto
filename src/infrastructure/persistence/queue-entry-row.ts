import type { Disposition } from "../../domain/policies/disposition.js";
import type { Proposal } from "../../ports/proposal.js";
import type { QueuedProposal } from "../../ports/review-queue-store.js";

/** A `projection_queue_entries` row as SQLite returns it. */
export interface QueueEntryRow {
  readonly proposal_id: string;
  readonly capture_id: string;
  /** The Proposal as JSON — read whole by the surface, never queried by field. */
  readonly proposal: string;
  readonly disposition: string;
  readonly confidence: number;
  /** SQLite has no boolean; 0 or 1, mapped at this boundary and nowhere else. */
  readonly was_sampled: number;
  readonly adjudicated_at: string | null;
  readonly queued_at: string;
}

export function toInsertParameters(entry: QueuedProposal): Record<string, unknown> {
  return {
    proposal_id: entry.proposal.proposalId,
    capture_id: entry.proposal.captureId,
    proposal: JSON.stringify(entry.proposal),
    disposition: entry.disposition,
    confidence: entry.confidence,
    was_sampled: entry.wasSampled ? 1 : 0,
    adjudicated_at: entry.adjudicatedAt,
    queued_at: entry.queuedAt,
  };
}

/** A row rebuilt into the entry it was stored from. */
export function toQueuedProposal(row: QueueEntryRow): QueuedProposal {
  return {
    proposal: JSON.parse(row.proposal) as Proposal,
    disposition: row.disposition as Disposition,
    confidence: row.confidence,
    wasSampled: row.was_sampled === 1,
    adjudicatedAt: row.adjudicated_at,
    queuedAt: row.queued_at,
  };
}
