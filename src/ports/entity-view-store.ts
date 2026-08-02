import type { Entity } from "../domain/knowledge/entity.js";
import type { FieldProvenance } from "../domain/knowledge/projected-state.js";
import type { Relation } from "../domain/knowledge/relation.js";
import type { EntityType } from "../domain/schema/entity-schema.js";

/**
 * The reads the dashboard makes: an entity with its relations and provenance,
 * and full-text search over Captures and entities.
 *
 * Separate from `EntityRepository` because the two serve different callers.
 * That port is resolution's, narrowed to the three candidate lookups
 * (ADR-0003); this one is the UI's, and the split is what keeps candidate
 * generation from acquiring a `search` it would be tempted to use as a fourth
 * source.
 *
 * **Every read here tolerates staleness** (`add.md` §6). The projection lags
 * the log by however long the worker takes, and nothing on this interface
 * blocks until it catches up — a caller that needs to know how far behind it is
 * asks the `ProjectionStore` for a checkpoint.
 */
export interface EntityViewStore {
  /**
   * An entity with its relations and per-field provenance, or `undefined` when
   * the projection holds no such entity.
   *
   * `undefined` rather than an error, because a missing projection is a state
   * the application must handle gracefully (`qa.md` §9) — the entity may be
   * genuinely unknown, or the worker may not have reached the event that
   * creates it, and the read path cannot tell those apart or block on either.
   */
  entityView(id: string): Promise<EntityView | undefined>;

  /** Every entity of a type, name-ordered. The list behind a type's index page. */
  entitiesOfType(type: EntityType): Promise<readonly Entity[]>;

  /** Captures whose text matches, best match first. */
  searchCaptures(query: string, limit?: number): Promise<readonly CaptureHit[]>;

  /** Entities whose fields match, best match first. */
  searchEntities(query: string, limit?: number): Promise<readonly EntityHit[]>;
}

/**
 * What `add.md` §7 calls "a row and a handful of joins": the Person view.
 *
 * The provenance map is the read that justifies the log — every field names the
 * event that last set it, and through it the Capture, the model, the
 * confidence, and whether a human confirmed it.
 */
export interface EntityView {
  readonly entity: Entity;
  readonly relations: readonly Relation[];
  /** Per field name, the event that last wrote it. */
  readonly provenance: ReadonlyMap<string, FieldProvenance>;
}

/** A Capture matched by full-text search. */
export interface CaptureHit {
  readonly captureId: string;
  readonly text: string;
}

/** An entity matched by full-text search. */
export interface EntityHit {
  readonly entityId: string;
  readonly entityType: EntityType;
}

/** How many hits a search returns when the caller does not say. */
export const DEFAULT_SEARCH_LIMIT = 20;
