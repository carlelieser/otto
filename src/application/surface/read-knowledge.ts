import type { Entity } from "../../domain/knowledge/entity.js";
import type { FieldProvenance } from "../../domain/knowledge/projected-state.js";
import type { EntityType } from "../../domain/schema/entity-schema.js";
import type {
  CaptureHit,
  EntityHit,
  EntityView,
  EntityViewStore,
} from "../../ports/entity-view-store.js";
import type { Checkpoint, ProjectionStore } from "../../ports/projection-store.js";

/**
 * The read side of the application, in one place (`add.md` §7).
 *
 * Thin on purpose: the queries are the store's and the fold is the domain's, so
 * what is left here is the part neither owns — saying how complete an answer is.
 * Every read on this surface reports the projection's staleness alongside the
 * data, because `add.md` §6 makes lag the contract rather than a defect, and a
 * caller that cannot see the lag has no way to honour it.
 *
 * The dashboard's own handling of staleness — treating an applied event as
 * immediately true in the local view rather than blocking — is Slice 11's, and
 * `freshness` is what it needs from here to do it.
 */
export class KnowledgeReads {
  readonly #views: EntityViewStore;
  readonly #projections: ProjectionStore;

  constructor(views: EntityViewStore, projections: ProjectionStore) {
    this.#views = views;
    this.#projections = projections;
  }

  /**
   * An entity with its relations and per-field provenance, and how current the
   * answer is.
   *
   * A missing entity is `undefined` in the `view` rather than an error
   * (`qa.md` §9). Whether that means "no such entity" or "the worker has not
   * reached it yet" is exactly what `freshness` answers.
   */
  async entityView(id: string): Promise<ReadResult<EntityView | undefined>> {
    return this.#withFreshness(await this.#views.entityView(id));
  }

  /** Every entity of a type, name-ordered. */
  async entitiesOfType(type: EntityType): Promise<ReadResult<readonly Entity[]>> {
    return this.#withFreshness(await this.#views.entitiesOfType(type));
  }

  /** Captures whose text matches, best match first. */
  async searchCaptures(query: string, limit?: number): Promise<ReadResult<readonly CaptureHit[]>> {
    return this.#withFreshness(await this.#views.searchCaptures(query, limit));
  }

  /** Entities whose fields match, best match first. */
  async searchEntities(query: string, limit?: number): Promise<ReadResult<readonly EntityHit[]>> {
    return this.#withFreshness(await this.#views.searchEntities(query, limit));
  }

  /**
   * How current the projection is: the position it reflects, and whether a
   * rebuild is in flight.
   *
   * Read *after* the data rather than before, so the reported freshness never
   * claims more than the data can support. Reading it first would let a batch
   * land in between and produce an answer stamped as older than it is, which is
   * the harmless direction — but the reverse ordering makes the opposite
   * mistake, and a read that overstates its own currency is one a caller cannot
   * defend against.
   */
  async #withFreshness<Data>(data: Data): Promise<ReadResult<Data>> {
    return { data, freshness: await this.#projections.checkpoint() };
  }
}

/**
 * An answer from the read path, with how complete the projection behind it was.
 *
 * `isRebuilding` is the field that distinguishes "Otto does not know this" from
 * "Otto has not finished remembering it" — `qa.md` §7.1 requires a
 * partially-populated projection not be presented as complete, and this is how
 * a caller can tell.
 */
export interface ReadResult<Data> {
  readonly data: Data;
  readonly freshness: Checkpoint;
}

/**
 * Re-exported so a caller has one import for the read path.
 *
 * The shapes belong to the port, which is what the store implements; that a
 * caller of this surface also needs their names is not a reason to declare them
 * twice.
 */
export type { CaptureHit, EntityHit, EntityView, FieldProvenance };
