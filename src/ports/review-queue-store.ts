import type { Disposition } from "../domain/policies/disposition.js";
import type { Proposal } from "./proposal.js";

/**
 * The triaged Proposals the review queue is built from (`add.md` §7, §10).
 *
 * ## Why this exists alongside `ProposalStore`
 *
 * `ProposalStore` holds *extraction's* output: a Mention and its claimed
 * values, with no entity named and no Command built (ADR-0019). The queue needs
 * the *differ's* output — the Command, so adjudicating it can hand something to
 * the executor, plus the two Confidences and the resolution summary the entry
 * shows. Nothing durable held that before this slice, because Slice 5 triaged
 * in memory and recorded only the decision.
 *
 * So a queue entry is the Proposal joined to its disposition, and this is where
 * the Proposal half lives. `DispositionStore` keeps the other half and keeps
 * its own lifetime: a discard expires at thirty days and the Proposal behind it
 * does not.
 *
 * ## It is a projection
 *
 * `projection_`-prefixed, droppable, and rebuildable by re-running the differ
 * and triage over stored Captures — the same argument ADR-0019 makes for
 * `extraction_proposals`, one stage later. No immutability triggers, and
 * re-recording a `proposalId` is a no-op like every other store here.
 */
export interface ReviewQueueStore {
  /** Records triaged Proposals so the queue can show them. A repeat is a no-op. */
  put(entries: readonly QueuedProposal[]): Promise<readonly QueuedProposal[]>;

  /**
   * The queue, newest first, optionally narrowed to one disposition.
   *
   * Filterable because the surface shows two lists that are the same shape: the
   * proposals awaiting judgement and the record of what was auto-applied
   * (PRD §5.4). One query with a filter rather than two methods, so a third
   * band never becomes a third method.
   */
  list(filter?: QueueFilter): Promise<readonly QueuedProposal[]>;

  /** One entry, or `undefined` when the queue holds no such Proposal. */
  get(proposalId: string): Promise<QueuedProposal | undefined>;

  /**
   * Marks an entry adjudicated, so a confirmed Proposal leaves the queue.
   *
   * Separate from deleting it: the entry stays readable, because PRD §5.4 wants
   * what Otto did to remain visible rather than vanish on confirmation, and
   * because a correction months later has to be able to name the Proposal it
   * corrected.
   */
  markAdjudicated(proposalId: string, adjudicatedAt: string): Promise<void>;
}

/**
 * A triaged Proposal as the queue holds it: what would change, what triage
 * decided, and whether a human has answered yet.
 */
export interface QueuedProposal {
  readonly proposal: Proposal;
  /** What triage decided. `auto_apply` entries are records, not requests. */
  readonly disposition: Disposition;
  /** `p(correct)` at the moment of triage. */
  readonly confidence: number;
  /**
   * Whether calibration sampling pulled this out of auto-apply.
   *
   * **In the data and never in the UI** (`triage.md` §6, ADR-0006). It is on
   * this type because calibration has to find these later; the surface that
   * renders a queue entry must not read it, and a test asserts that it does
   * not. A user who knows they are being measured adjudicates differently, and
   * a measurement that changes what it measures is not one.
   */
  readonly wasSampled: boolean;
  /** When a human answered, or `null` while the entry is still waiting. */
  readonly adjudicatedAt: string | null;
  /** When triage decided, ISO 8601. The queue's ordering key. */
  readonly queuedAt: string;
}

/** How the queue is narrowed. Absent fields do not narrow. */
export interface QueueFilter {
  readonly disposition?: Disposition;
  /** When true, only entries no human has answered yet. */
  readonly awaitingAdjudication?: boolean;
}
