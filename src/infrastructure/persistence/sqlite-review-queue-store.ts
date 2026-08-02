import type Database from "better-sqlite3";
import type {
  QueueFilter,
  QueuedProposal,
  ReviewQueueStore,
} from "../../ports/review-queue-store.js";
import { type QueueEntryRow, toInsertParameters, toQueuedProposal } from "./queue-entry-row.js";

const INSERT_ENTRY = `
INSERT INTO projection_queue_entries (
  proposal_id, capture_id, proposal, disposition, confidence,
  was_sampled, adjudicated_at, queued_at
) VALUES (
  @proposal_id, @capture_id, @proposal, @disposition, @confidence,
  @was_sampled, @adjudicated_at, @queued_at
)
ON CONFLICT (proposal_id) DO NOTHING`;

const SELECT_BY_ID = `SELECT * FROM projection_queue_entries WHERE proposal_id = ?`;

/**
 * Newest first — the order a queue reads in, and the order `queue_by_disposition`
 * indexes. `proposal_id` breaks ties so a batch triaged in one millisecond
 * still comes back in a stable order.
 */
const SELECT_ALL = `
SELECT * FROM projection_queue_entries
WHERE (:disposition IS NULL OR disposition = :disposition)
  AND (:awaiting IS NULL OR adjudicated_at IS NULL)
ORDER BY queued_at DESC, proposal_id DESC`;

const MARK_ADJUDICATED = `
UPDATE projection_queue_entries SET adjudicated_at = ? WHERE proposal_id = ?`;

/**
 * The triaged Proposals behind the review queue (`add.md` §7).
 *
 * A `projection_` table with no immutability triggers, for ADR-0019's reason
 * one stage on: every row is reproducible by re-running the differ and triage
 * over a stored Capture. `markAdjudicated` is an UPDATE, which is exactly what
 * that prefix is a promise about — a table that rebuilds is a table something
 * must be able to write over.
 */
export class SqliteReviewQueueStore implements ReviewQueueStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  /** Inserts in one transaction, so a Capture's entries arrive whole or not at all. */
  async put(entries: readonly QueuedProposal[]): Promise<readonly QueuedProposal[]> {
    if (entries.length === 0) return [];
    this.#insertAll(entries);
    return this.#reread(entries);
  }

  #insertAll(entries: readonly QueuedProposal[]): void {
    const insert = this.#database.prepare(INSERT_ENTRY);
    this.#database.transaction((rows: readonly QueuedProposal[]) => {
      for (const entry of rows) insert.run(toInsertParameters(entry));
    })(entries);
  }

  async #reread(entries: readonly QueuedProposal[]): Promise<readonly QueuedProposal[]> {
    const stored = await Promise.all(entries.map(({ proposal }) => this.get(proposal.proposalId)));
    return stored.filter((entry): entry is QueuedProposal => entry !== undefined);
  }

  async list(filter: QueueFilter = {}): Promise<readonly QueuedProposal[]> {
    const rows = this.#database.prepare(SELECT_ALL).all({
      disposition: filter.disposition ?? null,
      awaiting: filter.awaitingAdjudication === true ? 1 : null,
    }) as QueueEntryRow[];
    return rows.map(toQueuedProposal);
  }

  async get(proposalId: string): Promise<QueuedProposal | undefined> {
    const row = this.#database.prepare(SELECT_BY_ID).get(proposalId) as QueueEntryRow | undefined;
    return row === undefined ? undefined : toQueuedProposal(row);
  }

  /**
   * Silent about a Proposal it does not hold, matching every other store here:
   * a port that throws where its siblings no-op makes every caller learn which
   * is which.
   */
  async markAdjudicated(proposalId: string, adjudicatedAt: string): Promise<void> {
    this.#database.prepare(MARK_ADJUDICATED).run(adjudicatedAt, proposalId);
  }
}
