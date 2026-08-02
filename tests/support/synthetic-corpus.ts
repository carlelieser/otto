import type { DomainEvent } from "../../src/domain/events/domain-event.js";
import {
  ENTITIES_RELATED,
  ENTITY_CREATED,
  FIELD_SET,
  KNOWLEDGE_EVENT_VERSION,
  SET_MEMBER_ADDED,
} from "../../src/domain/events/knowledge-events.js";
import { ENTITY_AGGREGATE } from "../../src/domain/commands/knowledge-commands.js";
import type { Capture } from "../../src/ports/capture-store.js";

/**
 * `qa.md` §8's corpus: 10,000 Captures, ~50,000 events, ~3,000 entities,
 * ~10,000 relations, "biased heavy so a pass means comfortable".
 *
 * Built deterministically from an index rather than randomly, so two runs on
 * one machine measure the same work and a regression is a change in the code
 * rather than in the fixture. There is no seeded RNG here for the same reason
 * there is no randomness: a corpus that varies between runs makes the baseline
 * column meaningless, and the baseline is what `qa.md` §8 says matters more
 * than the bars.
 *
 * **The spike's harness was throwaway and its projection logic was a stand-in**
 * (§8's own caveat). This corpus feeds the real projector, which does more per
 * event than the spike's did — which §8 names as the most likely way the suite
 * goes red.
 */

export const CORPUS = {
  captures: 10_000,
  entities: 3_000,
  relations: 10_000,
} as const;

const ENTITY_TYPES = ["Person", "Project", "Idea", "Event", "Task"] as const;

/** The `single` fields written per entity, drawn from `schema.md`'s shared set. */
const SINGLE_FIELDS = ["summary", "employer", "role", "location"] as const;

/** The `set` fields, so the corpus exercises the union path as well as supersession. */
const SET_FIELDS = ["aliases", "notes"] as const;

/**
 * Field events per entity: each `single` field written twice, plus one member
 * added to each `set` field.
 */
const FIELD_EVENTS_PER_ENTITY = SINGLE_FIELDS.length * 2 + SET_FIELDS.length;

/**
 * How many events the corpus holds: a create plus its field events per entity,
 * plus the relations.
 *
 * Stated rather than measured, because a rebuild that silently folds fewer
 * events than the log holds is exactly the vacuous-fast result `qa.md` §8 warns
 * about — and a test asserting "more than some round number" would not have
 * caught the first version of this corpus, which wrote one field twice and
 * another never.
 */
export const EXPECTED_EVENTS = CORPUS.entities * (1 + FIELD_EVENTS_PER_ENTITY) + CORPUS.relations;

/**
 * The whole synthetic log: creates, field writes, set additions, and relations.
 *
 * 43,000 events at the specified corpus — 3,000 creates, 30,000 field events,
 * and 10,000 relations — against §8's "~50,000", biased toward field writes
 * because that is what a real log is mostly made of.
 */
export function syntheticLog(): readonly DomainEvent[] {
  const events: DomainEvent[] = [];
  for (let index = 0; index < CORPUS.entities; index += 1) {
    events.push(...eventsForEntity(index));
  }
  events.push(...relationEvents());
  return events;
}

function eventsForEntity(index: number): readonly DomainEvent[] {
  const id = entityId(index);
  const type = ENTITY_TYPES[index % ENTITY_TYPES.length]!;
  const created = event(ENTITY_CREATED, id, { entityType: type, name: entityName(index) }, index);
  return [created, ...fieldEventsFor(id, index)];
}

/**
 * Eight field events per entity, mixing supersession and set growth.
 *
 * The supersessions matter: `qa.md` §8's correctness checks require that a
 * single-valued field hold the *last* event's value, which a corpus that only
 * ever writes each field once could not detect.
 */
/**
 * Eight events per entity: each `single` field written twice, then two
 * additions to each `set` field.
 *
 * The double write is what makes `qa.md` §8's "single-valued fields hold the
 * last event's value" check able to fail. A corpus writing each field once
 * satisfies it trivially — the first value is also the last — which is exactly
 * the vacuous pass §8 warns the correctness checks exist to prevent.
 */
function fieldEventsFor(id: string, index: number): readonly DomainEvent[] {
  const singles = SINGLE_FIELDS.flatMap((field, ordinal) => [
    fieldEvent(FIELD_SET, id, field, `superseded ${index}-${ordinal}`, index * 100 + ordinal),
    fieldEvent(FIELD_SET, id, field, `value ${index}-${ordinal}`, index * 100 + 10 + ordinal),
  ]);
  const members = SET_FIELDS.map((field, ordinal) =>
    fieldEvent(
      SET_MEMBER_ADDED,
      id,
      field,
      `member ${index}-${ordinal}`,
      index * 100 + 20 + ordinal,
    ),
  );
  return [...singles, ...members];
}

function fieldEvent(
  type: string,
  id: string,
  field: string,
  value: string,
  ordinal: number,
): DomainEvent {
  return event(type, id, { field, value }, ordinal);
}

/** 10,000 `relates_to` edges, each between two entities the log created. */
function relationEvents(): readonly DomainEvent[] {
  return Array.from({ length: CORPUS.relations }, (_, index) => {
    const from = index % CORPUS.entities;
    const to = (index * 7 + 1) % CORPUS.entities;
    return event(
      ENTITIES_RELATED,
      entityId(from),
      {
        relation: "relates_to",
        fromId: entityId(from),
        fromType: "Idea",
        toId: entityId(to === from ? (to + 1) % CORPUS.entities : to),
        toType: "Idea",
      },
      1_000_000 + index,
    );
  });
}

/** 10,000 Captures with searchable text, for the full-text bar. */
export function syntheticCaptures(): readonly Capture[] {
  return Array.from({ length: CORPUS.captures }, (_, index) => ({
    captureId: `cap-${index}`,
    source: "typed" as const,
    rawText: captureText(index),
    correctedText: null,
    transcriptionModel: null,
    sourceTimestamp: timestampAt(index),
    contentHash: `hash-${index}`,
    ingestedAt: timestampAt(index),
  }));
}

/**
 * Capture text with a rare term in a known fraction of rows.
 *
 * `Helios` appears every hundredth Capture, so the search bar measures a query
 * that returns a bounded result set rather than one matching everything — which
 * would time the result serialisation instead of the index.
 */
function captureText(index: number): string {
  const subject = index % 100 === 0 ? "Helios" : `topic${index % 37}`;
  return `Note ${index} about ${subject} with ${entityName(index % CORPUS.entities)} and some surrounding words`;
}

export function entityId(index: number): string {
  return `ent-${index.toString().padStart(5, "0")}`;
}

function entityName(index: number): string {
  return `Entity Number ${index}`;
}

function timestampAt(index: number): string {
  return new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
}

/** An event with provenance, stamped so every field has a pointer to check. */
function event(type: string, aggregateId: string, payload: unknown, ordinal: number): DomainEvent {
  return {
    eventId: `evt-${type}-${aggregateId}-${ordinal}`,
    type,
    version: KNOWLEDGE_EVENT_VERSION,
    aggregate: { type: ENTITY_AGGREGATE, id: aggregateId, version: 0 },
    payload,
    provenance: {
      proposalId: `prop-${ordinal}`,
      captureId: `cap-${ordinal % CORPUS.captures}`,
      provider: "local",
      modelVersion: "qwen2.5-7b-instruct",
      confidence: 0.5 + (ordinal % 50) / 100,
      isHumanConfirmed: ordinal % 10 === 0,
    },
    recordedAt: timestampAt(ordinal % CORPUS.captures),
  };
}
