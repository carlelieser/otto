import type { LogPosition } from "../domain/events/domain-event.js";
import type { KnowledgeState } from "../domain/knowledge/projected-state.js";

/**
 * Where a projection is written, and how far it has got.
 *
 * The projection worker's only write surface, and deliberately coarse: it takes
 * a whole `KnowledgeState` rather than offering per-entity writes. The fold is
 * pure and produces a complete state (`project-entity.ts`), so a port with
 * `setField` on it would invite a second fold written in SQL — two
 * implementations of one rule, which is the arrangement `add.md` §9 exists to
 * prevent.
 *
 * It is a separate port from `EntityRepository` because the two answer to
 * different layers. `inference/` holds a repository that cannot write
 * (ADR-0003); `application/` holds this, which cannot read a candidate. Neither
 * side can reach the other's half by accident.
 */
export interface ProjectionStore {
  /**
   * Writes a folded state and records the position it reflects, in one
   * transaction.
   *
   * Atomic because the alternative is a projection whose recorded position is
   * ahead of its rows: a crash between the two writes would make the next
   * startup resume past events it never folded, and the missing entities would
   * never come back without a full rebuild nobody knew to run.
   */
  write(state: KnowledgeState, position: LogPosition): Promise<void>;

  /**
   * Empties every projection table and forgets the position.
   *
   * The operation ADR-0005 calls routine rather than disaster recovery, and
   * `qa.md` §9's answer to a corrupt projection: delete and rebuild.
   */
  reset(): Promise<void>;

  /**
   * Rebuilds the projections that are derived from `captures` rather than from
   * the log.
   *
   * Capture text appears in no event — `CaptureIngested` carries the id and the
   * hash — so the full-text index over Captures cannot be folded and has to be
   * rebuilt from the table that is truth. It is on this port rather than left
   * to a caller because `reset` empties that index: a rebuild that did not put
   * it back would leave Capture search silently returning nothing, which is the
   * routine operation of ADR-0005 quietly destroying a read surface.
   */
  reindexCaptures(): Promise<void>;

  /** How far the projection has folded, and whether a rebuild is in flight. */
  checkpoint(): Promise<Checkpoint>;

  /**
   * The folded state as it currently stands, for a worker resuming mid-log.
   *
   * Catch-up cannot start from an empty state and write the result: a
   * `SetMemberAdded` needs the members already in the set to union against, and
   * an entity's version is a count of every event folded into it, not of the
   * ones in this batch. Both would come out wrong, and the second silently —
   * a version that restarts at 1 makes an optimistic-concurrency check pass
   * that should have failed.
   *
   * So the state round-trips through the tables, and `qa.md` §8's
   * partial-plus-catch-up check is what proves the round-trip is lossless.
   */
  read(): Promise<KnowledgeState>;

  /**
   * Marks a rebuild as started, so a crash mid-rebuild is visible afterwards.
   *
   * `qa.md` §7.1: a partially-populated projection must not be presented as
   * complete. This is the flag that distinguishes the two, and it is set before
   * the first write rather than after, since the crash it guards against
   * happens in between.
   */
  beginRebuild(): Promise<void>;

  /** Marks the projection caught up, clearing the rebuild flag. */
  finishRebuild(position: LogPosition): Promise<void>;
}

/** How far a projection has folded the log. */
export interface Checkpoint {
  readonly position: LogPosition;
  /**
   * Whether a rebuild began and has not finished.
   *
   * True after a crash mid-rebuild, which is the case a read surface must be
   * able to tell from an empty projection — one is incomplete and the other is
   * a log with nothing in it.
   */
  readonly isRebuilding: boolean;
}

/** A projection that has folded nothing: the state before the first run. */
export const NOTHING_PROJECTED: Checkpoint = { position: 0, isRebuilding: false };

/**
 * The name the projection worker records its position under.
 *
 * One name because there is one worker folding one state. `add.md` §6 draws
 * five projections off the bus, and they are built here as one fold rather than
 * five subscriptions — five workers over one SQLite connection would serialise
 * behind each other anyway (`runtime.md` §1's single writer), and the position
 * bookkeeping would be five rows that must agree.
 */
export const KNOWLEDGE_PROJECTION = "knowledge";
