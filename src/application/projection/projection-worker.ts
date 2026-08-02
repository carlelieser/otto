import type { DomainEvent, LogPosition, StoredEvent } from "../../domain/events/domain-event.js";
import type { UpcastRegistry } from "../../domain/events/upcast-registry.js";
import { applyEvents } from "../../domain/knowledge/project-entity.js";
import {
  emptyKnowledge,
  markWritten,
  type KnowledgeState,
} from "../../domain/knowledge/projected-state.js";
import { serialiseKnowledge } from "../../domain/knowledge/serialise-knowledge.js";
import { FROM_START, type EventStore } from "../../ports/event-store.js";
import { KNOWLEDGE_PROJECTION, type ProjectionStore } from "../../ports/projection-store.js";
import {
  isSnapshotDue,
  MVP_SNAPSHOT_POLICY,
  type Snapshot,
  type SnapshotPolicy,
  type SnapshotStore,
} from "./snapshot.js";

/**
 * The projection worker: it reads the log forward, upcasts each event to its
 * current shape, folds it, and writes the result (`add.md` §6).
 *
 * **It runs in its own process** so that a full rebuild never blocks capture or
 * the pipeline (`add.md` §4). Nothing here assumes that — the class is a plain
 * object a host drives — but it is why `catchUp` is a method a caller schedules
 * rather than a loop this file owns, and why the position lives in the database
 * rather than in a field.
 *
 * **Rebuild is routine** (ADR-0005), not disaster recovery: `rebuild` drops
 * every projection and replays, and `qa.md` §7.1 requires the result to be
 * byte-identical to the incremental one. The two paths differ only in where
 * they start, which is what makes that property hold by construction rather
 * than by two implementations agreeing.
 */

/** How many events are read from the log at a time. */
const BATCH_SIZE = 1_000;

export interface ProjectionDependencies {
  readonly events: EventStore;
  readonly projections: ProjectionStore;
  /**
   * The upcasts, applied at read time so the log is never migrated (ADR-0011).
   *
   * Held by the worker rather than by the store because this is the one place
   * an event is read for folding — `add.md` §6 puts upcasting "at read time in
   * the projection worker", and anywhere else would be a second place old
   * payloads are interpreted.
   */
  readonly upcasts: UpcastRegistry;
  /**
   * Where snapshots go, absent when nothing is keeping them.
   *
   * Optional because the cadence ships at never (`runtime.md` §4.1) and a
   * required store would be a dependency every caller wires for a mechanism
   * that does not run.
   */
  readonly snapshots?: SnapshotStore;
  /** Defaults to the MVP policy, which is a cadence of never. */
  readonly snapshotPolicy?: SnapshotPolicy;
}

export class ProjectionWorker {
  readonly #dependencies: ProjectionDependencies;

  constructor(dependencies: ProjectionDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Folds everything appended since the last run.
   *
   * The read surface lags by however long this takes, which every read surface
   * tolerates (`add.md` §6) rather than blocking on.
   */
  async catchUp(): Promise<LogPosition> {
    const { projections } = this.#dependencies;
    const { position } = await projections.checkpoint();
    return this.#foldFrom(position, await projections.read());
  }

  /**
   * Drops every projection and replays the whole log.
   *
   * The rebuild flag is set before the first row is written and cleared after
   * the last, so a crash in between leaves the projection visibly incomplete
   * rather than silently short (`qa.md` §7.1).
   */
  async rebuild(): Promise<LogPosition> {
    const { projections } = this.#dependencies;
    await projections.reset();
    await projections.beginRebuild();
    const position = await this.#foldFrom(FROM_START, emptyKnowledge());
    await projections.finishRebuild(position);
    return position;
  }

  /**
   * Reads forward in batches, folding each into the carried state.
   *
   * The whole state is written per batch rather than per event: the fold is
   * pure and cheap, and one transaction per event would make a 50,000-event
   * rebuild 50,000 transactions, which is the shape `qa.md` §8 warns turns into
   * several bars degrading together.
   */
  async #foldFrom(start: LogPosition, initial: KnowledgeState): Promise<LogPosition> {
    let state = initial;
    let position = start;
    for (;;) {
      const batch = await this.#dependencies.events.readForward(position, BATCH_SIZE);
      if (batch.length === 0) return position;
      position = lastPositionOf(batch, position);
      state = await this.#writeBatch(applyEvents(state, this.#allCurrent(batch)), position);
    }
  }

  /** Writes a folded batch and returns the state with its touched set cleared. */
  async #writeBatch(state: KnowledgeState, position: LogPosition): Promise<KnowledgeState> {
    await this.#dependencies.projections.write(state, position);
    const written = markWritten(state);
    await this.#snapshotIfDue(written, position);
    return written;
  }

  #allCurrent(batch: readonly StoredEvent[]): DomainEvent[] {
    return batch.map((event) => this.#toCurrent(event));
  }

  async #snapshotIfDue(state: KnowledgeState, position: LogPosition): Promise<void> {
    const { snapshots, snapshotPolicy = MVP_SNAPSHOT_POLICY } = this.#dependencies;
    if (snapshots !== undefined) await saveIfDue(snapshots, snapshotPolicy, state, position);
  }

  /**
   * An event in its current shape.
   *
   * An event whose type has no declared version passes through untouched rather
   * than throwing. The registry knows the types someone registered upcasts for,
   * and a projection that refused everything else would fail on the first event
   * type nobody thought to declare — which is a strictly worse failure than
   * folding a payload that is already current.
   */
  #toCurrent(event: StoredEvent): DomainEvent {
    const { upcasts } = this.#dependencies;
    return upcasts.currentVersion(event.type) === undefined
      ? event
      : upcasts.upcastToCurrent(event);
  }
}

/** The position of the last event in a batch, or the one carried in if it is empty. */
function lastPositionOf(batch: readonly StoredEvent[], fallback: LogPosition): LogPosition {
  return batch[batch.length - 1]?.position ?? fallback;
}

/**
 * Writes a snapshot when the cadence says one is due.
 *
 * Under the MVP policy the cadence is never and this is always a no-op
 * (`runtime.md` §4.1). It is here rather than absent because the mechanism is
 * the expensive part to add later and the cadence is a constant — and because a
 * mechanism with no caller is one nothing proves still works.
 */
async function saveIfDue(
  snapshots: SnapshotStore,
  policy: SnapshotPolicy,
  state: KnowledgeState,
  position: LogPosition,
): Promise<void> {
  const previous = await snapshots.latest(KNOWLEDGE_PROJECTION);
  if (!isSnapshotDue(policy, previous?.position ?? FROM_START, position)) return;
  await snapshots.save(snapshotOf(state, position));
}

/**
 * A snapshot holds the serialised state rather than the maps themselves.
 *
 * A `SnapshotStore` may write to disk, and `Map` does not survive JSON. The
 * canonical form is what the rebuild property already compares, so it is a
 * shape that is known to round-trip rather than a second serialisation.
 */
function snapshotOf(state: KnowledgeState, position: LogPosition): Snapshot {
  return {
    projectionName: KNOWLEDGE_PROJECTION,
    position,
    state: serialiseKnowledge(state),
    takenAt: new Date().toISOString(),
  };
}
