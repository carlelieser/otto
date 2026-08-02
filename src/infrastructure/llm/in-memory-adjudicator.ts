import type { Adjudication, AdjudicationRequest, Adjudicator } from "../../ports/adjudicator.js";
import { isChosenIndexInRange } from "../../ports/adjudicator.js";

/**
 * An `Adjudicator` returning canned choices, so resolution runs with no model
 * at all.
 *
 * One of the four ports where a second adapter *is* load-bearing (`add.md` §9):
 * there is no offline mode for a model, and without a stub the ambiguous path
 * — the one adjudication exists for — is untestable.
 *
 * **It declines by default**, and that is the deliberate choice rather than an
 * arbitrary one. A stub that picked the first candidate would make every
 * unfixtured ambiguous case resolve to *something*, which is exactly the
 * failure ADR-0009 biases against, and it would do it invisibly in tests whose
 * subject is something else. Declining is the answer the design prefers when
 * unsure, so it is the answer the stub gives when it has not been told.
 */
export class InMemoryAdjudicator implements Adjudicator {
  readonly #choices: ReadonlyMap<string, number | null>;
  readonly #provider: string;
  readonly #modelVersion: string;

  constructor(options: InMemoryAdjudicatorOptions = {}) {
    this.#choices = new Map(options.choices ?? []);
    this.#provider = options.provider ?? IN_MEMORY_ADJUDICATOR_PROVIDER;
    this.#modelVersion = options.modelVersion ?? IN_MEMORY_ADJUDICATOR_MODEL;
  }

  async adjudicate(request: AdjudicationRequest): Promise<Adjudication> {
    const canned = this.#choices.get(request.mentionText.trim());
    return {
      chosenIndex: this.#choiceWithin(canned, request.candidates.length),
      provider: this.#provider,
      modelVersion: this.#modelVersion,
    };
  }

  /**
   * A canned choice, or none when it was not fixtured or names a candidate that
   * is not on this list.
   *
   * The range check is the same one the real adapters apply, and it is here for
   * the reason `add.md` §9 gives: a stub that accepts what the real adapter
   * refuses is two implementations that silently disagree, which is what Slice
   * 0's in-memory `EventStore` did.
   */
  #choiceWithin(choice: number | null | undefined, candidateCount: number): number | null {
    if (choice === undefined || choice === null) return null;
    return isChosenIndexInRange(choice, candidateCount) ? choice : null;
  }
}

export interface InMemoryAdjudicatorOptions {
  /** Zero-based candidate indices keyed by the Mention text they answer. */
  readonly choices?: Iterable<readonly [string, number | null]>;
  readonly provider?: string;
  readonly modelVersion?: string;
}

/**
 * Deliberately not `local`, matching `InMemoryExtractor`.
 *
 * Provenance carries the provider so a knowledge base built across a
 * configuration change stays legible (ADR-0016), and a stub claiming to be the
 * local model would put unattributable rows in the correction log that triage's
 * per-model thresholds later key on (ADR-0008).
 */
export const IN_MEMORY_ADJUDICATOR_PROVIDER = "in-memory";

export const IN_MEMORY_ADJUDICATOR_MODEL = "canned";
