import type { FieldProvenance } from "../../domain/knowledge/projected-state.js";
import type { Provenance } from "../../domain/values/provenance.js";

/** A `projection_field_provenance` row as SQLite returns it. */
export interface ProvenanceRow {
  readonly entity_id: string;
  readonly field: string;
  readonly event_id: string;
  readonly proposal_id: string | null;
  readonly capture_id: string;
  readonly provider: string;
  readonly model_version: string;
  readonly confidence: number | null;
  readonly is_human_confirmed: number;
  readonly recorded_at: string;
}

/**
 * The bound parameters a provenance insert needs.
 *
 * The columns mirror `events`' provenance columns exactly, which is what makes
 * "the pointer resolves through to the model and confidence" a read of one row
 * rather than a join back to the log (`add.md` §7).
 */
export function toProvenanceParameters(
  entityId: string,
  field: string,
  pointer: FieldProvenance,
): Record<string, unknown> {
  const { provenance } = pointer;
  return {
    entity_id: entityId,
    field,
    event_id: pointer.eventId,
    recorded_at: pointer.recordedAt,
    proposal_id: provenance.proposalId,
    capture_id: provenance.captureId,
    provider: provenance.provider,
    model_version: provenance.modelVersion,
    confidence: provenance.confidence,
    is_human_confirmed: provenance.isHumanConfirmed ? 1 : 0,
  };
}

/** A row rebuilt into the pointer it was stored from. */
export function toFieldProvenance(row: ProvenanceRow): FieldProvenance {
  return {
    eventId: row.event_id,
    recordedAt: row.recorded_at,
    provenance: toProvenance(row),
  };
}

function toProvenance(row: ProvenanceRow): Provenance {
  return {
    proposalId: row.proposal_id,
    captureId: row.capture_id,
    provider: row.provider,
    modelVersion: row.model_version,
    confidence: row.confidence,
    isHumanConfirmed: row.is_human_confirmed === 1,
  };
}
