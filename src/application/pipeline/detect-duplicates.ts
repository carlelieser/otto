import { deriveDuplicateId } from "../../capture/capture-identity.js";
import type { Command } from "../../domain/commands/command.js";
import {
  ENTITY_AGGREGATE,
  MERGE_ENTITIES,
  type MergeEntitiesPayload,
} from "../../domain/commands/knowledge-commands.js";
import type { Entity } from "../../domain/knowledge/entity.js";
import { ENTITY_TYPES, type EntityType } from "../../domain/schema/entity-schema.js";
import { humanConfirmedProvenance } from "../../domain/values/provenance.js";
import {
  suspectedDuplicates,
  type SuspectedDuplicate,
} from "../../inference/duplicates/detect-duplicates.js";
import type { Proposal } from "../../ports/proposal.js";
import type { QueuedProposal, ReviewQueueStore } from "../../ports/review-queue-store.js";

/**
 * **Suspected duplicates into the review queue** (`triage.md` §5, ADR-0012).
 *
 * The detection is `inference/duplicates/`, pure and testable with no fixtures.
 * What is here is the I/O it cannot do: reading the entity table and writing
 * entries the user can confirm.
 *
 * ## It does not go through triage
 *
 * Every other Proposal is triaged into a band. This one is not, and the reason
 * is that triage's answer is already known: the application policy's `merge` row
 * is `needs_review` at any confidence (`triage.md` §3), and merge is a kind of
 * change rather than a number. Running it through a threshold would be asking a
 * question whose answer the domain has already fixed — and would create a path
 * on which a very confident merge could apply unattended, which is precisely
 * what ADR-0007 forbids.
 *
 * So entries are written at `needs_review` directly, and the merge waits for the
 * user. `tests/application/detect-duplicates.test.ts` re-verifies the Slice 5
 * policy against this path rather than trusting that it was checked once.
 *
 * ## The sweep is idempotent
 *
 * A duplicate's Proposal id is derived from the pair alone, so a sweep over an
 * unchanged table re-proposes the same entry rather than a second copy of one
 * question. The store's `put` is a no-op for an id it already holds.
 */

/** Where the stage reads entities from, narrowed to the one read it makes. */
export interface DuplicateReads {
  (type: EntityType): Promise<readonly Entity[]>;
}

export interface DuplicateDependencies {
  /** Every entity of a type, from the projection the merge itself will change. */
  readonly entities: DuplicateReads;
  readonly queue: ReviewQueueStore;
  readonly now: () => string;
}

/**
 * The model a suspected duplicate is attributed to.
 *
 * Detection is arithmetic over names — no model runs, and there is nothing to
 * calibrate — so naming a provider here would create a bootstrap bucket that can
 * never fill and a threshold row nothing reads, which is the mistake
 * `aCaptureProvenance` documents for the transcriber. `HUMAN_PROVIDER` is the
 * closest true thing: this Proposal exists to be answered by a human and carries
 * no inference to describe.
 */
const DETECTION_MODEL = { provider: "human", modelVersion: "duplicate-detection" } as const;

/** Detection over the entity table, and the queue entries it produces. */
export class DuplicateDetection {
  readonly #dependencies: DuplicateDependencies;

  constructor(dependencies: DuplicateDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Sweeps every entity type and queues what it finds.
   *
   * Per type rather than across the whole table, because two entities of
   * different types are never one thing — a Person named "Helios" and a Project
   * named "Helios" are exactly what the type split is for.
   */
  async sweep(): Promise<readonly SuspectedDuplicate[]> {
    const found = await Promise.all(ENTITY_TYPES.map((type) => this.#sweepType(type)));
    const pairs = found.flat();
    await this.#dependencies.queue.put(pairs.map((pair) => this.#entryOf(pair)));
    return pairs;
  }

  async #sweepType(type: EntityType): Promise<readonly SuspectedDuplicate[]> {
    return suspectedDuplicates(await this.#dependencies.entities(type));
  }

  /**
   * A pair as a queue entry: `needs_review`, never sampled, unanswered.
   *
   * `wasSampled` is false because sampling is about the auto-apply band
   * (`triage.md` §6) and nothing here can reach it — there is no draw to make
   * when the disposition is fixed by the domain.
   */
  #entryOf(pair: SuspectedDuplicate): QueuedProposal {
    return {
      proposal: this.#proposalOf(pair),
      disposition: "needs_review",
      confidence: pair.similarity,
      wasSampled: false,
      adjudicatedAt: null,
      queuedAt: this.#dependencies.now(),
    };
  }

  /**
   * The Proposal behind the entry.
   *
   * `captureId` is the Proposal's own id, because there is no Capture: nothing
   * the user said produced this, and pointing at an unrelated Capture would put
   * a note in the provenance trail that never mentioned either entity.
   *
   * `confidences` carries the similarity as the extraction figure and `null` for
   * resolution, which is the shape `triage.md` §1 gives a change with no
   * candidate it was chosen over. Nothing triages it, so neither number is read
   * — they are recorded because a Proposal that lied about them would be worse
   * than one that reports what was actually measured.
   *
   * The outcome is `rejected_candidates` because that is how the pair came to
   * exist: resolution saw a plausible candidate and decided against it, which is
   * the bias ADR-0009 takes deliberately and the decision this queue entry is the
   * remedy for.
   */
  #proposalOf(pair: SuspectedDuplicate): Proposal {
    const proposalId = deriveDuplicateId(pair);
    return {
      proposalId,
      captureId: proposalId,
      command: mergeCommand(pair, proposalId),
      confidences: { extraction: pair.similarity, resolution: null },
      resolution: { outcome: "rejected_candidates", wasAdjudicated: false, candidateCount: 1 },
      entityType: pair.entityType,
      model: DETECTION_MODEL,
      proposedAt: this.#dependencies.now(),
    };
  }
}

/**
 * The Command the user confirms: merge the loser into the survivor.
 *
 * `expectedVersion` is 0 rather than the survivor's current version, and that is
 * deliberate. The version stamp exists to catch a target moving while an
 * *inference* waited (`add.md` §5.6), and this is not one — a suspected duplicate
 * is a pair of ids, and the pair does not stop being a duplicate because someone
 * set a field on one of them. Adjudication restamps against the current version
 * when the user answers, which is the same path a correction takes.
 */
function mergeCommand(pair: SuspectedDuplicate, proposalId: string): Command<MergeEntitiesPayload> {
  return {
    type: MERGE_ENTITIES,
    aggregate: { type: ENTITY_AGGREGATE, id: pair.survivorId, expectedVersion: 0 },
    payload: { mergedId: pair.mergedId },
    provenance: humanConfirmedProvenance(proposalId, proposalId),
  };
}
