import type { Disposition } from "../domain/policies/disposition.js";

/**
 * Where triage's decision about a Proposal is recorded (`triage.md` §7,
 * ADR-0014).
 *
 * ## Why discards are written rather than dropped
 *
 * A silent `discard` is the one triage outcome that would be invisible to the
 * user, and invisible is what PRD §8 says kills trust. "Why didn't Otto pick
 * that up?" needs an answer, and the low threshold needs an audit trail — a
 * band that turns out to be too aggressive is only recoverable by examining
 * what it dropped.
 *
 * ## Deliberately not a second review queue
 *
 * The surface this feeds is a list of what was dropped and which Capture it
 * came from, with no affordance to act on it beyond re-capturing. Making
 * discards actionable would turn the low band into a second queue, which is
 * exactly what the threshold exists to prevent — so there is no `apply` here
 * and no method that turns a discard into anything else.
 *
 * Separate from `ProposalStore` because that port holds extraction's output and
 * this holds triage's decision about it. The two have different lifetimes:
 * a Proposal is derived and rebuildable, and a discard is retained for thirty
 * days and then is not.
 */
export interface DispositionStore {
  /** Records what triage decided. Re-recording the same Proposal is a no-op. */
  put(records: readonly DispositionRecord[]): Promise<readonly DispositionRecord[]>;

  /** Every decision recorded for this Capture, in the order they were made. */
  forCapture(captureId: string): Promise<readonly DispositionRecord[]>;

  /**
   * Discards still within their retention window as of `asOf`.
   *
   * Takes the instant rather than reading a clock so the retention boundary is
   * testable at all — "present at 29 days, absent after 30" is not a thing a
   * test can assert against a store that decides for itself what time it is.
   */
  discards(asOf: string): Promise<readonly DispositionRecord[]>;

  /** Removes discards past their retention window. Returns how many went. */
  purgeExpiredDiscards(asOf: string): Promise<number>;
}

/** What triage decided about one Proposal, and enough to answer for it. */
export interface DispositionRecord {
  readonly proposalId: string;
  /** Named so a discard can say which Capture it came from (`triage.md` §7). */
  readonly captureId: string;
  readonly disposition: Disposition;
  /** `p(correct)` at the moment of triage, frozen like any provenance figure. */
  readonly confidence: number;
  /**
   * Whether calibration sampling pulled this out of auto-apply.
   *
   * **In the data and not in the UI** (`triage.md` §6). Calibration needs to
   * find these later; a user who knows they are being measured adjudicates
   * differently, so nothing downstream may render it.
   */
  readonly wasSampled: boolean;
  /** When triage decided, ISO 8601. Retention counts from here. */
  readonly decidedAt: string;
}
