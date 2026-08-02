import type Database from "better-sqlite3";
import type { DispositionRecord, DispositionStore } from "../../ports/disposition-store.js";
import { type DispositionRow, toInsertParameters, toRecord } from "./disposition-row.js";

const INSERT_DISPOSITION = `
INSERT INTO proposal_dispositions (
  proposal_id, capture_id, disposition, confidence, was_sampled, decided_at, expires_at
) VALUES (
  @proposal_id, @capture_id, @disposition, @confidence, @was_sampled, @decided_at, @expires_at
)
ON CONFLICT (proposal_id) DO NOTHING`;

const SELECT_BY_CAPTURE = `
SELECT * FROM proposal_dispositions WHERE capture_id = ? ORDER BY decided_at, proposal_id`;

/**
 * Unexpired discards, newest first — the order the collapsed section reads in.
 *
 * The comparison is a plain `>` on a stored instant rather than date arithmetic
 * in SQL, because the thirty days is a domain rule and this is the place that
 * rule gets applied rather than the place it gets restated.
 */
const SELECT_LIVE_DISCARDS = `
SELECT * FROM proposal_dispositions
WHERE disposition = 'discard' AND expires_at > ?
ORDER BY decided_at DESC`;

const DELETE_EXPIRED_DISCARDS = `
DELETE FROM proposal_dispositions WHERE disposition = 'discard' AND expires_at <= ?`;

/**
 * Triage's decisions, durable so a discard has somewhere to be visible from
 * (`triage.md` §7).
 *
 * One adapter, per `add.md` §9. **No immutability triggers**, for the same
 * reason `extraction_proposals` has none (ADR-0019): a disposition is derived
 * state — reproducible by re-triaging a Proposal against the same thresholds —
 * and retention *requires* a delete path, so protecting the table would forbid
 * the thirty-day window it exists to implement.
 */
export class SqliteDispositionStore implements DispositionStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  /**
   * Inserts in one transaction, matching the other stores: a partial write of a
   * Capture's dispositions would leave some of its Proposals decided and the
   * rest looking untriaged.
   */
  async put(records: readonly DispositionRecord[]): Promise<readonly DispositionRecord[]> {
    if (records.length === 0) return [];
    this.#insertAll(records);
    return this.forCapture(records[0]!.captureId);
  }

  #insertAll(records: readonly DispositionRecord[]): void {
    const insert = this.#database.prepare(INSERT_DISPOSITION);
    this.#database.transaction((rows: readonly DispositionRecord[]) => {
      for (const record of rows) insert.run(toInsertParameters(record));
    })(records);
  }

  async forCapture(captureId: string): Promise<readonly DispositionRecord[]> {
    const rows = this.#database.prepare(SELECT_BY_CAPTURE).all(captureId) as DispositionRow[];
    return rows.map(toRecord);
  }

  async discards(asOf: string): Promise<readonly DispositionRecord[]> {
    const rows = this.#database.prepare(SELECT_LIVE_DISCARDS).all(asOf) as DispositionRow[];
    return rows.map(toRecord);
  }

  async purgeExpiredDiscards(asOf: string): Promise<number> {
    return this.#database.prepare(DELETE_EXPIRED_DISCARDS).run(asOf).changes;
  }
}
