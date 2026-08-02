import type Database from "better-sqlite3";
import type { Command } from "../../domain/commands/command.js";
import type { Correction } from "../../domain/knowledge/correction.js";
import type { CorrectionStore, RecordedCorrection } from "../../ports/correction-store.js";

const INSERT_CORRECTION = `
INSERT INTO projection_corrections (
  correction_id, proposal_id, capture_id, chosen, provider, model_version, corrected_at
) VALUES (
  @correction_id, @proposal_id, @capture_id, @chosen, @provider, @model_version, @corrected_at
)
ON CONFLICT (correction_id) DO NOTHING`;

/** The bootstrap counter: a `WHERE` on two indexed columns, never a join. */
const COUNT_FOR_MODEL = `
SELECT COUNT(*) AS count FROM projection_corrections
WHERE provider = ? AND model_version = ?`;

const SELECT_BY_PROPOSAL = `
SELECT * FROM projection_corrections
WHERE proposal_id = ? ORDER BY corrected_at, correction_id`;

const SELECT_ALL = `
SELECT * FROM projection_corrections ORDER BY corrected_at DESC, correction_id DESC`;

/** A `projection_corrections` row as SQLite returns it. */
interface CorrectionRow {
  readonly correction_id: string;
  readonly proposal_id: string;
  readonly capture_id: string;
  /** The chosen Command as JSON — the counterfactual, read whole. */
  readonly chosen: string;
  readonly provider: string;
  readonly model_version: string;
  readonly corrected_at: string;
}

/**
 * The correction corpus (ADR-0006).
 *
 * Every row is an input/correct-output pair, which is what makes this the eval
 * set, the calibration curve's input, and the source of in-context examples.
 * None of those tools ships in MVP (PRD §7.2) — the data does, because it is
 * unreconstructable later.
 */
export class SqliteCorrectionStore implements CorrectionStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  async put(corrections: readonly RecordedCorrection[]): Promise<readonly Correction[]> {
    if (corrections.length === 0) return [];
    this.#insertAll(corrections);
    return this.forProposal(corrections[0]!.correction.proposalId);
  }

  #insertAll(corrections: readonly RecordedCorrection[]): void {
    const insert = this.#database.prepare(INSERT_CORRECTION);
    this.#database.transaction((rows: readonly RecordedCorrection[]) => {
      for (const recorded of rows) insert.run(toInsertParameters(recorded));
    })(corrections);
  }

  async countForModel(provider: string, modelVersion: string): Promise<number> {
    const row = this.#database.prepare(COUNT_FOR_MODEL).get(provider, modelVersion) as {
      count: number;
    };
    return row.count;
  }

  async forProposal(proposalId: string): Promise<readonly Correction[]> {
    const rows = this.#database.prepare(SELECT_BY_PROPOSAL).all(proposalId) as CorrectionRow[];
    return rows.map(toCorrection);
  }

  async all(): Promise<readonly Correction[]> {
    return (this.#database.prepare(SELECT_ALL).all() as CorrectionRow[]).map(toCorrection);
  }
}

function toInsertParameters({ correction, model }: RecordedCorrection): Record<string, unknown> {
  return {
    correction_id: correction.correctionId,
    proposal_id: correction.proposalId,
    capture_id: correction.captureId,
    chosen: JSON.stringify(correction.chosen),
    provider: model.provider,
    model_version: model.modelVersion,
    corrected_at: correction.correctedAt,
  };
}

function toCorrection(row: CorrectionRow): Correction {
  return {
    correctionId: row.correction_id,
    proposalId: row.proposal_id,
    captureId: row.capture_id,
    chosen: JSON.parse(row.chosen) as Command,
    correctedAt: row.corrected_at,
  };
}
