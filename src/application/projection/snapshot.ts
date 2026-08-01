import type { LogPosition } from "../../domain/events/domain-event.js";

/**
 * A projection's state together with the log position it reflects.
 *
 * Snapshotting is a projection concern, not an aggregate one (ADR-0011):
 * nothing in Otto loads an aggregate by folding its events, so snapshotting the
 * projection keeps rebuild cost proportional to recent activity with no
 * per-aggregate machinery. Snapshots are themselves derived and disposable — a
 * corrupt or stale one is fixed by deleting it and replaying fully.
 */
export interface Snapshot<State = unknown> {
  readonly projectionName: string;
  readonly position: LogPosition;
  readonly state: State;
  readonly takenAt: string;
}

/**
 * How many events pass between snapshots.
 *
 * **Set to never for MVP, deliberately.** `runtime.md` §4.1: full rebuild is
 * 215 ms at the specified corpus and 15 s at 25× it, so there is nothing to
 * tune yet. The mechanism is kept because it is the expensive part to add
 * later; the cadence is a constant. Revisit if the log passes ~1M events.
 */
export const SNAPSHOT_CADENCE_NEVER = Number.POSITIVE_INFINITY;

export interface SnapshotPolicy {
  /** Events between snapshots; `SNAPSHOT_CADENCE_NEVER` disables writing them. */
  readonly cadence: number;
}

export const MVP_SNAPSHOT_POLICY: SnapshotPolicy = { cadence: SNAPSHOT_CADENCE_NEVER };

/** Whether a snapshot is due, given the position the last one reflected. */
export function isSnapshotDue(
  policy: SnapshotPolicy,
  lastSnapshotPosition: LogPosition,
  currentPosition: LogPosition,
): boolean {
  if (!Number.isFinite(policy.cadence)) return false;
  return currentPosition - lastSnapshotPosition >= policy.cadence;
}

/** Where snapshots are kept. Derived state, so losing one is a replay. */
export interface SnapshotStore {
  save(snapshot: Snapshot): Promise<void>;
  /** The most recent snapshot for a projection, or null to rebuild from zero. */
  latest(projectionName: string): Promise<Snapshot | null>;
  /** Discards a projection's snapshots, forcing a full replay. */
  discard(projectionName: string): Promise<void>;
}
