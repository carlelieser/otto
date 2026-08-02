import { deriveCorrectionId } from "../../capture/capture-identity.js";
import type { Command } from "../../domain/commands/command.js";
import type { Correction } from "../../domain/knowledge/correction.js";
import { humanConfirmedProvenance } from "../../domain/values/provenance.js";
import type { CorrectionStore } from "../../ports/correction-store.js";
import type { QueuedProposal, ReviewQueueStore } from "../../ports/review-queue-store.js";
import type { Executor } from "./execute-command.js";

/**
 * **Adjudicating from the review queue** (`add.md` §7, PRD §5.4, ADR-0006).
 *
 * The user confirms what Otto proposed, or corrects it by naming what they
 * chose instead. Both are one action from the queue and neither requires
 * navigating to the entity.
 *
 * ## It issues a Command directly to the executor
 *
 * `add.md` §7 states it plainly: the correction path does not re-enter the
 * pipeline. There is no extraction here, no resolution, and no differ — the
 * user has already decided, and re-deriving their decision from a model would
 * be asking Otto to second-guess the only unambiguous signal it gets.
 *
 * This module imports the executor and the two stores, and nothing
 * model-facing. That is what makes "the extractor is not invoked" a property of
 * the code rather than a claim a spy has to catch after the fact — the same
 * argument `repropose.ts` makes for the staleness path.
 *
 * ## Corrections append, never edit
 *
 * A correction is a compensating event followed by a projection update
 * (`add.md` §10). Nothing is deleted and no earlier event is rewritten: an
 * auto-applied change that turned out wrong keeps its event, and the chosen
 * Command lands on top of it. History stays intact, which is what makes "why
 * does Otto think this?" answerable months later.
 *
 * The queue entry is stamped rather than removed for the same reason. PRD §5.4
 * wants what Otto did to remain visible after the user has answered.
 */

/** What adjudication is wired to. No extractor, and that is the design. */
export interface AdjudicationDependencies {
  /** The only writer in Otto (ADR-0003), reached directly rather than through triage. */
  readonly executor: Executor;
  readonly queue: ReviewQueueStore;
  readonly corrections: CorrectionStore;
  /**
   * The current version of the aggregate a correction targets.
   *
   * **Only the correction path uses it, and that asymmetry is the point.** A
   * Proposal's `expectedVersion` exists to catch its target moving while the
   * Proposal waited (`add.md` §5.6), which is a check about an *inference*
   * going stale — so `confirm` keeps it and a moved target re-proposes.
   *
   * A correction is not an inference. The user is looking at the entity and
   * saying what it should be, and the most common thing they correct is a
   * change Otto *already applied* — which by definition moved the version past
   * whatever the Proposal was stamped with. Requiring the caller to supply a
   * version would mean the queue had to show one, and PRD §5.4's "correcting is
   * one action" is exactly the affordance that would cost.
   */
  readonly currentVersionOf: (aggregateId: string) => Promise<number>;
  readonly now: () => string;
}

/** A Proposal the queue does not hold cannot be adjudicated. */
export class UnknownProposalError extends Error {
  constructor(readonly proposalId: string) {
    super(`Cannot adjudicate ${proposalId}: the review queue holds no such Proposal`);
    this.name = "UnknownProposalError";
  }
}

export class ProposalAdjudication {
  readonly #dependencies: AdjudicationDependencies;

  constructor(dependencies: AdjudicationDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Applies the Proposal as Otto proposed it, marked as a human's change.
   *
   * No Correction is recorded: the user agreed, so there is no counterfactual
   * and nothing for the eval set to learn from. Only disagreement is data
   * (ADR-0006).
   *
   * A **repeat** of a confirmation already answered does nothing, for the
   * reason `correct` skips a repeated correction: the second submission of a
   * double-clicked Confirm would otherwise reach the executor against an
   * aggregate its own first submission just moved, and fail its version check —
   * reporting a stale target where there is none. The stamp is what identifies
   * it, since a confirmation has no answer to compare and being answered is the
   * whole of what the second click would repeat.
   */
  async confirm(proposalId: string): Promise<void> {
    const entry = await this.#require(proposalId);
    if (entry.adjudicatedAt !== null) return;
    await this.#apply(entry.proposal.command, entry);
    await this.#stamp(proposalId);
  }

  /**
   * Applies what the user chose instead, and records it as the counterfactual.
   *
   * The order is deliberate: the Command is applied first, so a correction is
   * never recorded for a change that failed its version check. A stale target
   * throws from the executor and leaves the corpus clean.
   *
   * A **repeat** of a correction already recorded returns it without applying
   * anything. Without that check the second submission of a double-clicked
   * correction reaches the executor against an aggregate its own first
   * submission just moved, and fails its version check — surfacing a stale-target
   * error for what is not a stale target. The id derivation is what makes the
   * repeat identifiable: same Proposal and same chosen Command is the same
   * correction, and a *different* answer is a different id and applies normally.
   *
   * The chosen Command is **restamped against the target's current version**,
   * which is what makes an auto-applied record correctable at all: its Proposal
   * was stamped before it applied, so every such correction would otherwise
   * fail a version check on a target the user is looking at right now. See
   * `currentVersionOf`.
   */
  async correct(proposalId: string, chosen: Command): Promise<Correction> {
    const entry = await this.#require(proposalId);
    const repeated = await this.#alreadyRecorded(proposalId, chosen);
    if (repeated !== undefined) return repeated;

    await this.#apply(await this.#restamped(chosen), entry);
    const correction = await this.#record(entry, chosen);
    await this.#stamp(proposalId);
    return correction;
  }

  /** The chosen Command against the version its target actually holds now. */
  async #restamped(chosen: Command): Promise<Command> {
    const expectedVersion = await this.#dependencies.currentVersionOf(chosen.aggregate.id);
    return { ...chosen, aggregate: { ...chosen.aggregate, expectedVersion } };
  }

  /** The correction already stored for this exact answer, if the user repeated it. */
  async #alreadyRecorded(proposalId: string, chosen: Command): Promise<Correction | undefined> {
    const stored = await this.#dependencies.corrections.forProposal(proposalId);
    const id = correctionIdFor(proposalId, chosen);
    return stored.find((correction) => correction.correctionId === id);
  }

  /** The queue entry, or a refusal naming the Proposal that is not there. */
  async #require(proposalId: string): Promise<QueuedProposal> {
    const entry = await this.#dependencies.queue.get(proposalId);
    if (entry === undefined) throw new UnknownProposalError(proposalId);
    return entry;
  }

  /**
   * Issues the Command with a human's provenance.
   *
   * The provenance is rewritten rather than carried through: the change is now
   * the user's, and `humanConfirmedProvenance` is what says so — no provider,
   * no model version, and a null Confidence, because a human-confirmed record
   * has no inference to describe.
   */
  async #apply(command: Command, entry: QueuedProposal): Promise<void> {
    const { proposalId, captureId } = entry.proposal;
    await this.#dependencies.executor.execute({
      ...command,
      provenance: humanConfirmedProvenance(captureId, proposalId),
    });
  }

  /** Records the counterfactual against the model whose Proposal got it wrong. */
  async #record(entry: QueuedProposal, chosen: Command): Promise<Correction> {
    const correction = this.#correctionOf(entry, chosen);
    await this.#dependencies.corrections.put([{ correction, model: entry.proposal.model }]);
    return correction;
  }

  #correctionOf(entry: QueuedProposal, chosen: Command): Correction {
    const { proposalId, captureId } = entry.proposal;
    return {
      correctionId: correctionIdFor(proposalId, chosen),
      proposalId,
      captureId,
      chosen,
      correctedAt: this.#dependencies.now(),
    };
  }

  async #stamp(proposalId: string): Promise<void> {
    await this.#dependencies.queue.markAdjudicated(proposalId, this.#dependencies.now());
  }
}

/**
 * The Correction's id, derived from the Proposal and the answer.
 *
 * The payload is serialised here rather than in the derivation, because
 * `capture-identity.ts` is where the *shape* of an id is fixed and JSON is a
 * property of this caller's Command rather than of the derivation.
 */
function correctionIdFor(proposalId: string, chosen: Command): string {
  return deriveCorrectionId({
    proposalId,
    chosenType: chosen.type,
    chosenTargetId: chosen.aggregate.id,
    chosenPayload: JSON.stringify(chosen.payload),
  });
}
