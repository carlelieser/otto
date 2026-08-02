import { ProjectionWorker } from "../application/projection/projection-worker.js";
import type { SnapshotStore } from "../application/projection/snapshot.js";
import { KnowledgeReads } from "../application/surface/read-knowledge.js";
import {
  KNOWLEDGE_EVENT_TYPES,
  KNOWLEDGE_EVENT_VERSION,
} from "../domain/events/knowledge-events.js";
import { identityUpcast, UpcastRegistry } from "../domain/events/upcast-registry.js";
import type { EventStore } from "../ports/event-store.js";
import type { EntityViewStore } from "../ports/entity-view-store.js";
import type { ProjectionStore } from "../ports/projection-store.js";

/**
 * Assembling the read side: the projection worker, its upcasts, and the read
 * surfaces over what it writes.
 *
 * Inside `composition/`, which shares the root's exemption from ADR-0001's
 * import rule. It moved out of `composition-root.ts` for the reason
 * `extractor-selection.ts` did — the root outgrew a readable length, and the
 * honest split is by what the code assembles rather than by moving a boundary.
 * Storage wiring and projection wiring change for different reasons.
 *
 * The dependencies are named as ports rather than as the `Storage` bundle, so
 * this module says what each function actually needs. A caller passing the
 * bundle still typechecks.
 */

/** What the worker is wired to: the log to read, and the tables to write. */
export interface ProjectionWiring {
  readonly events: EventStore;
  readonly projections: ProjectionStore;
}

/**
 * The projection worker, wired to the log and the projection tables.
 *
 * The upcast registry is built here rather than held as a module constant: it
 * is composition, and every knowledge event ships at version 1 with an identity
 * upcast (ADR-0011). What this buys is that the *seam* is assembled the way
 * production assembles it, rather than only in a test — a registry nothing
 * consults is one that has quietly stopped working by event type #20.
 */
export function createProjectionWorker(
  storage: ProjectionWiring,
  snapshots?: SnapshotStore,
): ProjectionWorker {
  return new ProjectionWorker({
    events: storage.events,
    projections: storage.projections,
    upcasts: createUpcastRegistry(),
    ...(snapshots === undefined ? {} : { snapshots }),
  });
}

/**
 * Every event type at its current version, each with an identity upcast.
 *
 * ADR-0011's cost, stated plainly: these accumulate and can never be deleted.
 * A new payload shape is a new version with an upcast from the old one, added
 * here — never an edit to an existing entry, which would rewrite the meaning of
 * events already in the log.
 */
export function createUpcastRegistry(): UpcastRegistry {
  const upcasts = new UpcastRegistry();
  for (const type of KNOWLEDGE_EVENT_TYPES) {
    upcasts.declareCurrentVersion(type, KNOWLEDGE_EVENT_VERSION);
    upcasts.register({ type, fromVersion: KNOWLEDGE_EVENT_VERSION, upcast: identityUpcast });
  }
  return upcasts;
}

/** What the read path is wired to: the views, and the checkpoint behind them. */
export interface ReadWiring {
  readonly views: EntityViewStore;
  readonly projections: ProjectionStore;
}

/** The read path, wired to the projection tables. */
export function createKnowledgeReads(storage: ReadWiring): KnowledgeReads {
  return new KnowledgeReads(storage.views, storage.projections);
}
