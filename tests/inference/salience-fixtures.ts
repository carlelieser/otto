import type { Entity } from "../../src/domain/knowledge/entity.js";
import type { Relation } from "../../src/domain/knowledge/relation.js";
import type { EntityType } from "../../src/domain/schema/entity-schema.js";
import type { ResolvedDate } from "../../src/domain/values/resolved-date.js";
import {
  NO_ACTIVITY,
  type EntityActivity,
  type SalientEntity,
} from "../../src/inference/salience/salient-entity.js";

/**
 * Fixtures for the selection tests.
 *
 * Every one is built against a fixed `NOW` rather than a clock, which is what
 * makes "which entities land in which section" (`qa.md` §11) an exact
 * assertion instead of one that passes until the date rolls over.
 */

/** The instant every fixture is dated against. */
export const NOW = "2026-08-02T12:00:00.000Z";

/** `days` before `NOW`, ISO 8601. A negative count is that many days after. */
export function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A resolved date at day precision, which is what most notes state. */
export function date(timestamp: string): ResolvedDate {
  return { timestamp, precision: "day", phrase: "a day" };
}

/**
 * An entity with a name and whatever fields the case needs.
 *
 * Dates are passed as ISO strings and wrapped here, so a fixture reads
 * `{ due: daysAgo(3) }` rather than restating the `ResolvedDate` shape in every
 * case.
 */
export function entity(
  type: EntityType,
  id: string,
  texts: Readonly<Record<string, string>> = {},
  dates: Readonly<Record<string, string>> = {},
): Entity {
  const fields: Record<string, readonly (string | ResolvedDate)[]> = { name: [`${type} ${id}`] };
  for (const [field, value] of Object.entries(texts)) fields[field] = [value];
  for (const [field, value] of Object.entries(dates)) fields[field] = [date(value)];
  return { id, type, fields, version: 1 };
}

/** An entity paired with when it was last mentioned and when it was created. */
export function salient(
  subject: Entity,
  lastMentionedAt: string,
  createdAt: string = lastMentionedAt,
): SalientEntity {
  return { entity: subject, lastMentionedAt, createdAt };
}

/** The same, with the change counts the weekly brief's sections read. */
export function active(subject: SalientEntity, activity: Partial<EntityActivity>): SalientEntity {
  return { ...subject, activity: { ...NO_ACTIVITY, ...activity } };
}

/** The common case: a Task with a status and a due date, mentioned when created. */
export function task(id: string, status: string, due: string): SalientEntity {
  return salient(entity("Task", id, { status }, { due }), due);
}

/** A `Project involves Person` edge, the most common relation in the graph. */
export function involves(projectId: string, personId: string): Relation {
  return {
    name: "involves",
    from: { id: projectId, type: "Project" },
    to: { id: personId, type: "Person" },
  };
}
