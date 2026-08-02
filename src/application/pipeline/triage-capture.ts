import { StaleCommandError, type Executor } from "./execute-command.js";
import { triage, type TriagedProposal } from "../../inference/calibration/triage.js";
import type { Draw } from "../../inference/calibration/sampling.js";
import type { DispositionRecord, DispositionStore } from "../../ports/disposition-store.js";
import type { Proposal } from "../../ports/proposal.js";
import type { QueuedProposal, ReviewQueueStore } from "../../ports/review-queue-store.js";

/**
 * **The stage where a Proposal becomes a decision, and a decision becomes an
 * event** (`add.md` §5.5, §5.6).
 *
 * The write path is complete from here: a spoken note becomes an event in the
 * log without a human touching it, when and only when Otto is confident enough
 * and the change is the kind that may happen unattended.
 *
 * ## What is in this file and what is not
 *
 * The *decision* is `inference/calibration/triage.ts` and the *rules about
 * knowledge* are `domain/policies/` — both pure, both testable with no
 * fixtures. What is here is the I/O those two cannot do: reading the correction
 * count, recording what was decided, and handing the auto-applies to the
 * executor. That split is ADR-0007's, and the reason this file is thin.
 *
 * ## Every disposition is recorded, including the discards
 *
 * A discard writes a row like any other outcome (`triage.md` §7). Silent
 * omission is the one triage outcome that would be invisible to the user, and
 * invisible is what PRD §8 says kills trust.
 */

/** Where the correction count for a Proposal's own model comes from. */
export interface CorrectionCounts {
  /** Corrections for this provider and model version (ADR-0008, `triage.md` §4). */
  forModel(provider: string, modelVersion: string): Promise<number>;
}

/**
 * The correction count before Corrections exist.
 *
 * Slice 7 owns Corrections, so until then this is the honest answer rather
 * than a placeholder: there are none, which means Otto ships in permanent
 * bootstrap and only unambiguous creates apply unattended. That is the correct
 * behaviour for a system whose calibration data does not exist yet rather than
 * a gap waiting to be filled.
 */
export const NO_CORRECTIONS: CorrectionCounts = { forModel: async () => 0 };

/** What triaging a Capture's Proposals produced. */
export interface TriageResult {
  readonly triaged: readonly TriagedProposal[];
  /** Proposals whose target moved while they waited (`triage.md` §8). */
  readonly stale: readonly Proposal[];
}

/** What the stage is wired to. The draw is here for the reason `sampling.ts` gives. */
export interface TriageDependencies {
  readonly executor: Executor;
  readonly dispositions: DispositionStore;
  /**
   * Where the review queue reads its entries from (Slice 7).
   *
   * Separate from `dispositions` because the two hold different halves and keep
   * different lifetimes: a disposition is triage's decision and a discard's
   * expires at thirty days, while the entry holds the Proposal itself — the
   * Command adjudication hands the executor — and outlives being answered.
   *
   * Optional so the stage stays constructible without it. A test about the
   * bootstrap arithmetic has no queue to write to and should not have to make
   * one to say so.
   */
  readonly queue?: ReviewQueueStore;
  readonly corrections: CorrectionCounts;
  readonly now: () => string;
  /**
   * The sampling draw, defaulting to real randomness.
   *
   * A seam so an integration test can assert what happens to a confident
   * proposal without one run in five being sampled into review underneath it.
   * **Not an off switch**: there is no value of this that stops sampling, only
   * values that decide which proposals it catches (`triage.md` §6).
   */
  readonly draw?: Draw;
}

/** Triage for a Capture's Proposals, and the executor for the ones that apply. */
export class CaptureTriage {
  readonly #dependencies: TriageDependencies;

  constructor(dependencies: TriageDependencies) {
    this.#dependencies = dependencies;
  }

  /** Triages each Proposal, records every decision, and applies what may apply. */
  async triageAll(proposals: readonly Proposal[]): Promise<TriageResult> {
    const triaged = await Promise.all(proposals.map((proposal) => this.#decide(proposal)));
    await this.#dependencies.dispositions.put(triaged.map((decision) => this.#recordOf(decision)));
    await this.#enqueue(triaged);
    return { triaged, stale: await this.#applyConfident(triaged) };
  }

  /**
   * Records what the queue shows: everything except the discards.
   *
   * A discard is written to `dispositions` and deliberately not here. The
   * collapsed section reads from that table instead, which is what keeps the
   * low band from becoming a second review queue — there is no entry carrying a
   * Command for a discard, so there is nothing for a surface to offer to apply
   * (`triage.md` §7).
   */
  async #enqueue(triaged: readonly TriagedProposal[]): Promise<void> {
    const { queue } = this.#dependencies;
    if (queue === undefined) return;
    const queued = triaged.filter((decision) => decision.disposition !== "discard");
    await queue.put(queued.map((decision) => this.#entryOf(decision)));
  }

  #entryOf(decision: TriagedProposal): QueuedProposal {
    const { proposal, disposition, confidence, wasSampled } = decision;
    return {
      proposal,
      disposition,
      confidence,
      wasSampled,
      adjudicatedAt: null,
      queuedAt: this.#dependencies.now(),
    };
  }

  async #decide(proposal: Proposal): Promise<TriagedProposal> {
    const { provider, modelVersion } = proposal.model;
    const correctionCount = await this.#dependencies.corrections.forModel(provider, modelVersion);
    return triage(proposal, { correctionCount, ...this.#drawOption() });
  }

  /** The draw, passed on only when one was supplied, so triage keeps its default. */
  #drawOption(): { draw?: Draw } {
    const { draw } = this.#dependencies;
    return draw === undefined ? {} : { draw };
  }

  #recordOf(decision: TriagedProposal): DispositionRecord {
    const { proposal, disposition, confidence, wasSampled } = decision;
    return {
      proposalId: proposal.proposalId,
      captureId: proposal.captureId,
      disposition,
      confidence,
      wasSampled,
      decidedAt: this.#dependencies.now(),
    };
  }

  /**
   * Applies every `auto_apply`, collecting the ones whose target moved.
   *
   * A stale Command is not an error here — it is the ordinary consequence of
   * user think-time, and the caller re-proposes it from the differ rather than
   * applying it blindly (`repropose.ts`).
   */
  async #applyConfident(triaged: readonly TriagedProposal[]): Promise<readonly Proposal[]> {
    const confident = triaged.filter((decision) => decision.disposition === "auto_apply");
    const outcomes = await Promise.all(
      confident.map((decision) => this.#applyOne(decision.proposal)),
    );
    return outcomes.filter((proposal): proposal is Proposal => proposal !== undefined);
  }

  /** Applies one Command, returning the Proposal when its version check failed. */
  async #applyOne(proposal: Proposal): Promise<Proposal | undefined> {
    try {
      await this.#dependencies.executor.execute(proposal.command);
      return undefined;
    } catch (error) {
      if (error instanceof StaleCommandError) return proposal;
      throw error;
    }
  }
}
