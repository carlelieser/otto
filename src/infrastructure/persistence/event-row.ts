import type { AggregateRef, DomainEvent, StoredEvent } from "../../domain/events/domain-event.js";
import type { Provenance } from "../../domain/values/provenance.js";

/** An `events` row as SQLite returns it. */
export interface EventRow {
  readonly position: number;
  readonly event_id: string;
  readonly type: string;
  readonly version: number;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly payload: string;
  readonly proposal_id: string | null;
  readonly capture_id: string;
  readonly provider: string;
  readonly model_version: string;
  readonly confidence: number | null;
  readonly is_human_confirmed: number;
  readonly recorded_at: string;
}

/** The bound parameters an insert needs, flattened from the event's nesting. */
export function toInsertParameters(event: DomainEvent): Record<string, unknown> {
  return {
    event_id: event.eventId,
    type: event.type,
    version: event.version,
    payload: JSON.stringify(event.payload),
    recorded_at: event.recordedAt,
    ...aggregateColumns(event.aggregate),
    ...provenanceColumns(event.provenance),
  };
}

function aggregateColumns(aggregate: AggregateRef): Record<string, unknown> {
  return {
    aggregate_type: aggregate.type,
    aggregate_id: aggregate.id,
    aggregate_version: aggregate.version,
  };
}

function provenanceColumns(provenance: Provenance): Record<string, unknown> {
  return {
    proposal_id: provenance.proposalId,
    capture_id: provenance.captureId,
    provider: provenance.provider,
    model_version: provenance.modelVersion,
    confidence: provenance.confidence,
    is_human_confirmed: provenance.isHumanConfirmed ? 1 : 0,
  };
}

/** A row rebuilt into the event it was stored from. */
export function toStoredEvent(row: EventRow): StoredEvent {
  return {
    position: row.position,
    eventId: row.event_id,
    type: row.type,
    version: row.version,
    payload: JSON.parse(row.payload) as unknown,
    recordedAt: row.recorded_at,
    aggregate: toAggregateRef(row),
    provenance: toProvenance(row),
  };
}

function toAggregateRef(row: EventRow): AggregateRef {
  return {
    type: row.aggregate_type,
    id: row.aggregate_id,
    version: row.aggregate_version,
  };
}

function toProvenance(row: EventRow): Provenance {
  return {
    proposalId: row.proposal_id,
    captureId: row.capture_id,
    provider: row.provider,
    modelVersion: row.model_version,
    confidence: row.confidence,
    isHumanConfirmed: row.is_human_confirmed === 1,
  };
}
