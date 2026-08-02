import fc from "fast-check";
import type { DomainEvent } from "../../src/domain/events/domain-event.js";
import {
  ENTITIES_MERGED,
  ENTITIES_RELATED,
  ENTITY_CREATED,
  FIELD_CLEARED,
  FIELD_SET,
  KNOWLEDGE_EVENT_VERSION,
  SET_MEMBER_ADDED,
} from "../../src/domain/events/knowledge-events.js";
import { ENTITY_AGGREGATE } from "../../src/domain/commands/knowledge-commands.js";

/**
 * Arbitrary event logs, for the property `qa.md` §7.1 calls the load-bearing
 * test of the projection design: **for any event log, dropping every projection
 * and rebuilding produces byte-identical state.**
 *
 * The generator is deliberately not restricted to logs the pipeline would
 * produce. It emits events against entities that were never created, fields
 * cleared that were never set, and relations between ids that do not exist —
 * because a projection that only survives well-formed input is a projection
 * that breaks the first time a partial rebuild reads a log mid-write.
 */

/** A small pool of ids, so generated events collide often enough to interact. */
const ENTITY_IDS = ["per-1", "per-2", "proj-1", "idea-1"] as const;

/** Fields drawn from `schema.md`, mixing `single` and `set` cardinalities. */
const SINGLE_FIELDS = ["employer", "role", "location", "summary"] as const;
const SET_FIELDS = ["aliases", "notes"] as const;

const anEntityId = fc.constantFrom(...ENTITY_IDS);
const aFieldValue = fc.string({ minLength: 1, maxLength: 12 });

const aCreatedEvent = fc.record({
  type: fc.constant(ENTITY_CREATED),
  aggregateId: anEntityId,
  payload: fc.record({
    entityType: fc.constantFrom("Person", "Project", "Idea"),
    name: fc.string({ minLength: 1, maxLength: 12 }),
  }),
});

const aFieldSetEvent = fc.record({
  type: fc.constant(FIELD_SET),
  aggregateId: anEntityId,
  payload: fc.record({ field: fc.constantFrom(...SINGLE_FIELDS), value: aFieldValue }),
});

const aSetMemberEvent = fc.record({
  type: fc.constant(SET_MEMBER_ADDED),
  aggregateId: anEntityId,
  payload: fc.record({ field: fc.constantFrom(...SET_FIELDS), value: aFieldValue }),
});

const aClearedEvent = fc.record({
  type: fc.constant(FIELD_CLEARED),
  aggregateId: anEntityId,
  payload: fc.record({
    field: fc.constantFrom(...SINGLE_FIELDS),
    because: fc.constantFrom(...SINGLE_FIELDS),
  }),
});

const aRelatedEvent = fc.record({
  type: fc.constant(ENTITIES_RELATED),
  aggregateId: anEntityId,
  payload: fc.record({
    relation: fc.constant("relates_to"),
    fromId: anEntityId,
    fromType: fc.constant("Idea"),
    toId: anEntityId,
    toType: fc.constant("Idea"),
  }),
});

/**
 * A merge folding one id from the pool into another.
 *
 * Generated freely, including merges of an entity into itself and of ids nothing
 * created — the generator's whole discipline is that it is not restricted to
 * logs the pipeline would produce, and a merge is the event where a dropped
 * branch removes an entity rather than leaving one out.
 *
 * Weighted below the others by appearing once among several shapes: a log where
 * every second event is a merge holds almost no entities to merge.
 */
const aMergedEvent = fc.record({
  type: fc.constant(ENTITIES_MERGED),
  aggregateId: anEntityId,
  payload: fc.record({ mergedId: anEntityId }),
});

/** One generated event, before its id and provenance are stamped on. */
const anyEventShape = fc.oneof(
  aCreatedEvent,
  aMergedEvent,
  aFieldSetEvent,
  aFieldSetEvent,
  aSetMemberEvent,
  aClearedEvent,
  aRelatedEvent,
);

/**
 * A log of well-formed events with distinct ids.
 *
 * Ids come from the index rather than a generator: the property is about the
 * fold, and two events sharing an id would test the log's idempotency instead.
 */
export const anEventLog = fc
  .array(anyEventShape, { minLength: 0, maxLength: 60 })
  .map((shapes) => shapes.map((shape, index) => stampEvent(shape, index)));

interface EventShape {
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: unknown;
}

function stampEvent(shape: EventShape, index: number): DomainEvent {
  return {
    eventId: `evt-${index}`,
    type: shape.type,
    version: KNOWLEDGE_EVENT_VERSION,
    aggregate: { type: ENTITY_AGGREGATE, id: shape.aggregateId, version: index },
    payload: shape.payload,
    provenance: {
      proposalId: `prop-${index}`,
      captureId: `cap-${index}`,
      provider: "test",
      modelVersion: "test-model-1",
      confidence: 0.9,
      isHumanConfirmed: index % 5 === 0,
    },
    recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  };
}
