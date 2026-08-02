import type { Command } from "../../domain/commands/command.js";
import type { EntityType } from "../../domain/schema/entity-schema.js";
import type { DispositionStore } from "../../ports/disposition-store.js";
import type { Checkpoint, ProjectionStore } from "../../ports/projection-store.js";
import type { QueuedProposal, ReviewQueueStore } from "../../ports/review-queue-store.js";
import type { ReadResult } from "./read-knowledge.js";

/**
 * **The review queue as the user sees it** (PRD §5.4, `add.md` §7).
 *
 * Three lists, and the difference between them is the whole surface: proposals
 * waiting for a decision, a record of what applied unattended, and the
 * collapsed section of what was dropped.
 *
 * ## The view type is where "indistinguishable" is enforced
 *
 * `triage.md` §6 requires a sampled proposal to appear in the queue exactly
 * like an ordinary one. That is not a rule this file remembers to follow — it
 * is a property of `QueueEntryView` having no field the mark could occupy.
 * `wasSampled` lives on the stored entry, calibration reads it there, and the
 * mapping below drops it. A user who knows they are being measured adjudicates
 * differently, and a measurement that changes what it measures is not one.
 *
 * ## The discard section can offer nothing
 *
 * `DiscardView` carries an id, a Capture, and a date. There is no Command on
 * it, so there is nothing a surface could render an Apply button for, and no
 * method here restores one. Making discards actionable would turn the low band
 * into a second review queue, which is what the threshold exists to prevent
 * (`triage.md` §7).
 *
 * Every read reports the projection's freshness for the reason `add.md` §6
 * gives: lag is the contract rather than a defect, and a caller that cannot see
 * it has no way to honour it.
 */
export class ReviewQueue {
  readonly #queue: ReviewQueueStore;
  readonly #dispositions: DispositionStore;
  readonly #projections: ProjectionStore;

  constructor(
    queue: ReviewQueueStore,
    dispositions: DispositionStore,
    projections: ProjectionStore,
  ) {
    this.#queue = queue;
    this.#dispositions = dispositions;
    this.#projections = projections;
  }

  /**
   * Proposals waiting for a decision — including the sampled ones, which is the
   * point of sampling and is invisible here.
   */
  async awaitingReview(): Promise<ReadResult<readonly QueueEntryView[]>> {
    const entries = await this.#queue.list({
      disposition: "needs_review",
      awaitingAdjudication: true,
    });
    return this.#withFreshness(entries.map(toEntryView));
  }

  /**
   * What applied unattended, shown as a record rather than a request.
   *
   * PRD §5.4: confident non-destructive changes stay visible and correctable
   * rather than silent. The user may still correct one, which is why these
   * carry the same shape as a request and differ only in `isRecord`.
   */
  async appliedRecords(): Promise<ReadResult<readonly QueueEntryView[]>> {
    const entries = await this.#queue.list({ disposition: "auto_apply" });
    return this.#withFreshness(entries.map(toEntryView));
  }

  /**
   * What was dropped, within the retention window.
   *
   * Takes the instant rather than reading a clock, so "present at 29 days,
   * absent after 30" is a thing a test can assert (`qa.md` §5.7).
   */
  async discards(asOf: string): Promise<ReadResult<readonly DiscardView[]>> {
    const records = await this.#dispositions.discards(asOf);
    return this.#withFreshness(records.map(toDiscardView));
  }

  /** Read after the data, so reported freshness never overstates it. */
  async #withFreshness<Data>(data: Data): Promise<ReadResult<Data>> {
    return { data, freshness: await this.#projections.checkpoint() };
  }
}

/**
 * One queue entry as the surface renders it: what changed, and enough to
 * confirm or correct it in one action.
 *
 * **There is no `wasSampled` here and there must never be one.** See the class
 * comment; a test asserts the absence over this type's own keys.
 *
 * There is no `confidence` either. The user is being asked whether Otto got it
 * right, and showing them the number Otto assigned to its own correctness
 * anchors that judgement — which would bias exactly the adjudications
 * calibration depends on being independent (ADR-0006).
 */
export interface QueueEntryView {
  readonly proposalId: string;
  /** The Capture behind it, so the entry can show what was said. */
  readonly captureId: string;
  /** What would change, stated plainly: "Sarah added to People." */
  readonly command: Command;
  readonly entityType: EntityType;
  /** How many candidates resolution weighed, which the entry shows. */
  readonly candidateCount: number;
  /**
   * Whether this already applied.
   *
   * The one thing distinguishing a record from a request, and it is about what
   * Otto *did* rather than about how it decided — so it carries no information
   * about the band, the threshold, or the sampling draw.
   */
  readonly isRecord: boolean;
  readonly queuedAt: string;
}

/**
 * A dropped proposal, and deliberately nothing more.
 *
 * No Command, no confidence, no disposition — three fields that answer "why
 * didn't Otto pick that up?" and support no other question. The shape is the
 * affordance, and this shape affords nothing but re-capturing.
 */
export interface DiscardView {
  readonly proposalId: string;
  /** Which Capture it came from (`triage.md` §7). */
  readonly captureId: string;
  readonly discardedAt: string;
}

/** The stored entry narrowed to what a surface may see. The mark does not survive. */
function toEntryView(entry: QueuedProposal): QueueEntryView {
  const { proposal, disposition, queuedAt } = entry;
  return {
    proposalId: proposal.proposalId,
    captureId: proposal.captureId,
    command: proposal.command,
    entityType: proposal.entityType,
    candidateCount: proposal.resolution.candidateCount,
    isRecord: disposition === "auto_apply",
    queuedAt,
  };
}

function toDiscardView(record: {
  readonly proposalId: string;
  readonly captureId: string;
  readonly decidedAt: string;
}): DiscardView {
  return {
    proposalId: record.proposalId,
    captureId: record.captureId,
    discardedAt: record.decidedAt,
  };
}

export type { Checkpoint };
