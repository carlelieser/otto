import type { Snapshot, SnapshotStore } from "../../application/projection/snapshot.js";

/**
 * Snapshots held in memory. Snapshots are derived and disposable, so this is a
 * complete implementation rather than a stand-in — losing them costs a replay,
 * which `runtime.md` §4 measures at 215 ms.
 */
export class InMemorySnapshotStore implements SnapshotStore {
  readonly #byProjection = new Map<string, Snapshot>();

  async save(snapshot: Snapshot): Promise<void> {
    const existing = this.#byProjection.get(snapshot.projectionName);
    const isNewer = existing === undefined || snapshot.position >= existing.position;
    if (isNewer) this.#byProjection.set(snapshot.projectionName, snapshot);
  }

  async latest(projectionName: string): Promise<Snapshot | null> {
    return this.#byProjection.get(projectionName) ?? null;
  }

  async discard(projectionName: string): Promise<void> {
    this.#byProjection.delete(projectionName);
  }
}
