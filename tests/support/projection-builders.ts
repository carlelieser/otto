import type { DomainEvent, StoredEvent } from "../../src/domain/events/domain-event.js";
import {
  ENTITIES_RELATED,
  ENTITY_CREATED,
  FIELD_CLEARED,
  FIELD_SET,
  KNOWLEDGE_EVENT_VERSION,
  SET_MEMBER_ADDED,
} from "../../src/domain/events/knowledge-events.js";
import { ENTITY_AGGREGATE } from "../../src/domain/commands/knowledge-commands.js";
import type { Provenance } from "../../src/domain/values/provenance.js";
import type { EntityValue } from "../../src/domain/knowledge/entity.js";

/**
 * Builders for the events a projection folds.
 *
 * Separate from `knowledge-builders.ts` because those build what the differ
 * compares against — entities as they already are — and these build the log
 * entries that put them there. A projection test states the log and asserts the
 * state; nothing in it needs a pre-built entity.
 */

/** The provenance every builder here defaults to, so a test states only what it is about. */
const DEFAULT_PROVENANCE: Provenance = {
  proposalId: "prop-1",
  captureId: "cap-1",
  provider: "test",
  modelVersion: "test-model-1",
  confidence: 0.9,
  isHumanConfirmed: false,
};

/** What a builder lets a test override: the event's identity and its provenance. */
export interface EventOverrides {
  readonly eventId?: string;
  readonly aggregateId?: string;
  readonly version?: number;
  readonly recordedAt?: string;
  readonly provenance?: Partial<Provenance>;
}

const DEFAULT_ENTITY_ID = "per-sarah";

/** An `EntityCreated` for Sarah, a Person. */
export function anEntityCreated(
  overrides: EventOverrides & { payload?: { entityType?: string; name?: string } } = {},
): DomainEvent {
  const { payload, ...rest } = overrides;
  return build(ENTITY_CREATED, { entityType: "Person", name: "Sarah Chen", ...payload }, rest);
}

/** A `FieldSet` against Sarah. */
export function aFieldSet(
  payload: { field: string; value: EntityValue },
  overrides: EventOverrides = {},
): DomainEvent {
  return build(FIELD_SET, payload, overrides);
}

/** A `SetMemberAdded` against Sarah. */
export function aSetMemberAdded(
  payload: { field: string; value: EntityValue },
  overrides: EventOverrides = {},
): DomainEvent {
  return build(SET_MEMBER_ADDED, payload, overrides);
}

/** A `FieldCleared` against Sarah. */
export function aFieldCleared(
  payload: { field: string; because: string },
  overrides: EventOverrides = {},
): DomainEvent {
  return build(FIELD_CLEARED, payload, overrides);
}

/** An `EntitiesRelated` linking the Helios project to Sarah. */
export function anEntitiesRelated(overrides: EventOverrides = {}): DomainEvent {
  return build(
    ENTITIES_RELATED,
    {
      relation: "involves",
      fromId: "proj-helios",
      fromType: "Project",
      toId: DEFAULT_ENTITY_ID,
      toType: "Person",
    },
    { aggregateId: "proj-helios", ...overrides },
  );
}

let sequence = 0;

/**
 * An event with defaults filled in and a unique id when none was given.
 *
 * The id is generated rather than fixed because two events with one id are one
 * event to an idempotent log, and a test arranging two `FieldSet`s wants two.
 */
function build(type: string, payload: unknown, overrides: EventOverrides): DomainEvent {
  sequence += 1;
  return {
    eventId: overrides.eventId ?? `evt-${sequence}`,
    type,
    version: KNOWLEDGE_EVENT_VERSION,
    aggregate: {
      type: ENTITY_AGGREGATE,
      id: overrides.aggregateId ?? DEFAULT_ENTITY_ID,
      version: overrides.version ?? 0,
    },
    payload,
    provenance: { ...DEFAULT_PROVENANCE, ...overrides.provenance },
    recordedAt: overrides.recordedAt ?? "2026-08-02T10:00:00.000Z",
  };
}

/** An event with the position the log would have assigned it. */
export function atPosition(event: DomainEvent, position: number): StoredEvent {
  return { ...event, position };
}

/** A log of events, each at the position its order implies. */
export function aLog(...events: readonly DomainEvent[]): readonly StoredEvent[] {
  return events.map((event, index) => atPosition(event, index + 1));
}
