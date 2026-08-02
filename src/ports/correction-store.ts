import type { Correction } from "../domain/knowledge/correction.js";
import type { ModelIdentity } from "./proposal.js";

/**
 * Where corrections are kept, and where bootstrap reads its counter from
 * (ADR-0006, `triage.md` §4).
 *
 * ## It is the calibration corpus
 *
 * Every row here is an input/correct-output pair: the Proposal Otto got wrong,
 * and what the user chose instead. ADR-0006 names the uses in descending order
 * of value — an eval set, threshold calibration, in-context examples, and plain
 * state — and all four need what the user chose rather than that they objected.
 *
 * The tuner that consumes this is post-MVP (PRD §7.2). The data is gathered
 * here because it is unreconstructable later, which is the whole argument.
 *
 * ## Counting is a method rather than a query the caller writes
 *
 * `countForModel` is on the port because bootstrap is per provider and model
 * version, and that pair is the one thing a caller could plausibly get wrong by
 * counting everything. A store that only offered `all()` would make the
 * bootstrap counter a filter each caller re-derives.
 */
export interface CorrectionStore {
  /** Records what the user chose instead. Re-recording the same one is a no-op. */
  put(corrections: readonly RecordedCorrection[]): Promise<readonly Correction[]>;

  /**
   * How many corrections exist for this provider and model version.
   *
   * The bootstrap counter (`triage.md` §4). Per model because a threshold
   * measured against one model says nothing about another (ADR-0008), so
   * switching models re-enters bootstrap with the old model's count intact
   * behind it.
   */
  countForModel(provider: string, modelVersion: string): Promise<number>;

  /** Every correction against one Proposal, oldest first. */
  forProposal(proposalId: string): Promise<readonly Correction[]>;

  /** Every correction, newest first. The eval set, read whole. */
  all(): Promise<readonly Correction[]>;
}

/**
 * A Correction and the model whose Proposal it corrects.
 *
 * The model is passed at write time rather than carried on `Correction`,
 * because it is a property of the *inference that was wrong* rather than of the
 * user's answer — the user did not choose a model, and a correction is a
 * revision of belief rather than a report about machinery (ADR-0002). It is
 * stored alongside so the bootstrap counter is a `WHERE`, not a join.
 */
export interface RecordedCorrection {
  readonly correction: Correction;
  /** The provider and model version of the Proposal that got it wrong (ADR-0008). */
  readonly model: ModelIdentity;
}
