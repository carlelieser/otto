import type { StoredEvent } from "../../domain/events/domain-event.js";
import { FIELD_SET } from "../../domain/events/knowledge-events.js";
import type { SetFieldPayload } from "../../domain/commands/knowledge-commands.js";
import { projectFromZero, relationsIn } from "../../domain/knowledge/project-entity.js";
import type { Relation } from "../../domain/knowledge/relation.js";
import type { EntityActivity, SalientEntity } from "../../inference/salience/salient-entity.js";
import { FROM_START, type EventStore } from "../../ports/event-store.js";
import { daysBetween } from "../../inference/salience/terms.js";

/**
 * The log folded into what salience scores: entities, their relations, and the
 * two facts about *when* that the fold reduces away.
 *
 * **This is what makes salience a projection rather than a formula** (ADD §8,
 * ADR-0015). Every input is derived here from the event log alone, so changing
 * a coefficient and recomputing is a rebuild over the same history — there is
 * no stored score, no decay job, and nothing to migrate.
 *
 * The fold produces current state, which is its job; `lastMentionedAt`,
 * `createdAt`, and the change counts are properties of the *history* that
 * produced that state, so they are gathered in the same pass rather than
 * reconstructed by a second one.
 */

/** Everything a selection needs, read from the log in one pass. */
export interface SalientKnowledge {
  readonly entities: readonly SalientEntity[];
  readonly relations: readonly Relation[];
}

/** The window `EntityActivity` counts against, in days. */
const WEEK = 7;

/**
 * The whole log read forward and folded.
 *
 * Reads from the log rather than from the projection tables because the
 * timestamps salience needs are on the events and not in the tables — the
 * projection stores what is true, and this needs to know when it became true.
 */
export async function readSalientEntities(
  events: EventStore,
  now: string,
): Promise<SalientKnowledge> {
  const log = await events.readForward(FROM_START);
  const state = projectFromZero(log);
  const history = historyOf(log, now);
  const entities = [...state.entities.values()].map((entity) => ({
    entity,
    ...(history.get(entity.id) ?? unseen(now)),
  }));
  return { entities, relations: relationsIn(state) };
}

/** What the log says about when each entity was touched, and how often. */
type History = Omit<SalientEntity, "entity">;

/** One pass over the log, accumulating per-entity timing and counts. */
function historyOf(log: readonly StoredEvent[], now: string): ReadonlyMap<string, History> {
  const history = new Map<string, History>();
  for (const event of log) {
    const id = event.aggregate.id;
    history.set(id, extend(history.get(id), event, now));
  }
  return history;
}

/** One entity's history with this event folded into it. */
function extend(existing: History | undefined, event: StoredEvent, now: string): History {
  const activity = countIn(existing?.activity, event, now);
  if (existing === undefined) {
    return { lastMentionedAt: event.recordedAt, createdAt: event.recordedAt, activity };
  }
  return { ...existing, lastMentionedAt: event.recordedAt, activity };
}

/** The counts with this event added to whichever window it falls in. */
function countIn(
  existing: EntityActivity | undefined,
  event: StoredEvent,
  now: string,
): EntityActivity {
  const elapsed = daysBetween(event.recordedAt, now);
  const activity = existing ?? EMPTY_ACTIVITY;
  return {
    changesThisWeek: activity.changesThisWeek + (elapsed <= WEEK ? 1 : 0),
    changesLastWeek: activity.changesLastWeek + (elapsed > WEEK && elapsed <= 2 * WEEK ? 1 : 0),
    statusChanged: activity.statusChanged || changesStatusThisWeek(event, elapsed),
    changesEver: activity.changesEver + 1,
  };
}

/** Whether this event set `status` inside the window the weekly brief covers. */
function changesStatusThisWeek(event: StoredEvent, elapsed: number): boolean {
  if (event.type !== FIELD_SET || elapsed > WEEK) return false;
  return (event.payload as SetFieldPayload).field === "status";
}

const EMPTY_ACTIVITY: EntityActivity = {
  changesThisWeek: 0,
  changesLastWeek: 0,
  statusChanged: false,
  changesEver: 0,
};

/**
 * The history of an entity the log does not account for.
 *
 * Should not arise — the fold creates entities only from events — but the map
 * lookup has to be total, and dating an unexplained entity to `now` scores it
 * as fresh rather than crashing a brief over one bad row.
 */
function unseen(now: string): History {
  return { lastMentionedAt: now, createdAt: now, activity: EMPTY_ACTIVITY };
}
