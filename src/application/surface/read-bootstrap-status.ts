import { BOOTSTRAP_CORRECTIONS, isInBootstrap } from "../../inference/calibration/bootstrap.js";
import type { CorrectionStore } from "../../ports/correction-store.js";
import type { ModelIdentity } from "../../ports/proposal.js";

/**
 * **Why Otto is asking so much** (`triage.md` §4, PRD §5.4, `qa.md` §5.4).
 *
 * Bootstrap is visible rather than silent. A user wondering why Otto holds back
 * from anything requiring a judgement about which entity was meant deserves the
 * answer that it is still learning what its own confidence is worth — and PRD
 * §5.4 makes the product argument: friction without explanation reads as the
 * product being bad at its job.
 *
 * ## It reports remaining, not only whether
 *
 * A boolean would satisfy "visible" and would leave the user unable to tell an
 * hour from a month. The count and the remainder make the friction finite,
 * which is the difference between an explanation and an apology.
 *
 * ## Per provider and model version
 *
 * ADR-0008. Switching models re-enters bootstrap with the old model's
 * corrections intact behind it, because a threshold measured against one model
 * says nothing about another. That makes a model change visibly costly, which
 * is honest.
 */
export class BootstrapStatus {
  readonly #corrections: CorrectionStore;

  constructor(corrections: CorrectionStore) {
    this.#corrections = corrections;
  }

  /** Where this model stands: bootstrapping or not, and how far along. */
  async forModel(model: ModelIdentity): Promise<BootstrapReport> {
    const correctionCount = await this.#corrections.countForModel(
      model.provider,
      model.modelVersion,
    );
    return {
      model,
      correctionCount,
      isBootstrapping: isInBootstrap(correctionCount),
      remaining: Math.max(0, BOOTSTRAP_CORRECTIONS - correctionCount),
    };
  }
}

/** What the dashboard shows about a model's calibration state. */
export interface BootstrapReport {
  /** The provider and model version this describes (ADR-0008). */
  readonly model: ModelIdentity;
  /** Corrections accumulated for this model. */
  readonly correctionCount: number;
  /** Whether Otto still lacks the data to be trusted with its own numbers. */
  readonly isBootstrapping: boolean;
  /** How many more corrections until bootstrap ends. Zero once it has. */
  readonly remaining: number;
}
