import type Database from "better-sqlite3";
import type { ExtractedProposal, ProposalStore } from "../../ports/proposal-store.js";
import { type ProposalRow, toInsertParameters, toProposal } from "./proposal-row.js";

const INSERT_PROPOSAL = `
INSERT INTO extraction_proposals (
  proposal_id, capture_id, ordinal, mention, provider, model_version, extracted_at
) VALUES (
  @proposal_id, @capture_id, @ordinal, @mention, @provider, @model_version, @extracted_at
)
ON CONFLICT (proposal_id) DO NOTHING`;

/**
 * Ordered by `ordinal` rather than by `extracted_at`, so a Capture's Mentions
 * come back in the order the model emitted them however coarse the clock is.
 * `proposals_by_capture` is the index this walks.
 */
const SELECT_BY_CAPTURE = `
SELECT * FROM extraction_proposals WHERE capture_id = ? ORDER BY ordinal`;

/**
 * Extraction's output, durable so the next stage can resume from it.
 *
 * One adapter, per `add.md` §9: a storage port's offline mode is `:memory:`,
 * and a second in-memory implementation is what Slice 0 removed after its fake
 * and its real adapter silently disagreed. The in-memory adapter this slice
 * *does* build is `InMemoryExtractor`, which stands in for a model rather than
 * for a database — the distinction §9 draws.
 */
export class SqliteProposalStore implements ProposalStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  /**
   * Inserts in one transaction, then re-reads.
   *
   * The transaction is what makes the stage's resumption check honest: the
   * check is "does this Capture have Proposals," so a partial write would leave
   * a Capture that looks extracted and is missing Mentions, and the worker
   * would resume past a call that never finished. All-or-nothing turns a crash
   * mid-write back into the case the check already handles — no Proposals, so
   * extract again.
   */
  async put(proposals: readonly ExtractedProposal[]): Promise<readonly ExtractedProposal[]> {
    if (proposals.length === 0) return [];
    this.#insertAll(proposals);
    return this.forCapture(proposals[0]!.captureId);
  }

  #insertAll(proposals: readonly ExtractedProposal[]): void {
    const insert = this.#database.prepare(INSERT_PROPOSAL);
    this.#database.transaction((rows: readonly ExtractedProposal[]) => {
      for (const [ordinal, proposal] of rows.entries()) {
        insert.run(toInsertParameters(proposal, ordinal));
      }
    })(proposals);
  }

  async forCapture(captureId: string): Promise<readonly ExtractedProposal[]> {
    const rows = this.#database.prepare(SELECT_BY_CAPTURE).all(captureId) as ProposalRow[];
    return rows.map(toProposal);
  }
}
