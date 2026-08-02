import type { Disposition } from "../../domain/policies/disposition.js";
import { discardExpiryOf } from "../../domain/policies/retention.js";
import type { DispositionRecord } from "../../ports/disposition-store.js";

/** A `proposal_dispositions` row as SQLite returns it. */
export interface DispositionRow {
  readonly proposal_id: string;
  readonly capture_id: string;
  readonly disposition: string;
  readonly confidence: number;
  /** SQLite has no boolean; 0 or 1, mapped at this boundary and nowhere else. */
  readonly was_sampled: number;
  readonly decided_at: string;
  /**
   * When a discard stops being shown, precomputed at write time.
   *
   * Stored rather than derived in the query because the retention window is a
   * domain rule (`retention.ts`) and SQL is not where a domain rule should be
   * restated as date arithmetic. It also makes the retention query a plain
   * comparison on an indexed column.
   */
  readonly expires_at: string | null;
}

export function toInsertParameters(record: DispositionRecord): Record<string, unknown> {
  return {
    proposal_id: record.proposalId,
    capture_id: record.captureId,
    disposition: record.disposition,
    confidence: record.confidence,
    was_sampled: record.wasSampled ? 1 : 0,
    decided_at: record.decidedAt,
    expires_at: expiryFor(record),
  };
}

/** Only a discard expires. A review or an auto-apply is not on a clock. */
function expiryFor(record: DispositionRecord): string | null {
  if (record.disposition !== "discard") return null;
  return discardExpiryOf(record.decidedAt);
}

/** A row rebuilt into the record it was stored from. */
export function toRecord(row: DispositionRow): DispositionRecord {
  return {
    proposalId: row.proposal_id,
    captureId: row.capture_id,
    disposition: row.disposition as Disposition,
    confidence: row.confidence,
    wasSampled: row.was_sampled === 1,
    decidedAt: row.decided_at,
  };
}
