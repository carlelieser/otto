import type { Entity } from "../../domain/knowledge/entity.js";
import type { Relation } from "../../domain/knowledge/relation.js";
import type { SalienceCoefficients } from "./coefficients.js";
import type { SelectedEntity } from "./brief-selection.js";
import type { SalientEntity } from "./salient-entity.js";
import { rankEntities, type SalienceScore } from "./score.js";
import { daysBetween } from "./terms.js";

/**
 * The parts daily and weekly selection share.
 *
 * Both walk one ranked list, filter it per section, and reduce what survives to
 * the shape the generator sees. Keeping that here rather than in either module
 * is what stops the two selections drifting into different ideas of what an
 * entity looks like once selected.
 */

/** An entity paired with the score the ranking gave it. */
export interface Scored {
  readonly subject: SalientEntity;
  readonly score: SalienceScore;
}

/**
 * Every entity ranked, each paired back with the entity it scored.
 *
 * The ranking returns scores keyed by id because that is what a ranking is;
 * every section then needs the entity itself to filter on. Pairing once here
 * rather than looking each up per section is the difference between one pass
 * and one per section.
 */
export function rankAndPair(
  entities: readonly SalientEntity[],
  relations: readonly Relation[],
  now: string,
  coefficients: SalienceCoefficients,
): readonly Scored[] {
  const byId = new Map(entities.map((entity) => [entity.entity.id, entity]));
  return rankEntities(entities, relations, now, coefficients).flatMap((score) => {
    const subject = byId.get(score.entityId);
    return subject === undefined ? [] : [{ subject, score }];
  });
}

/**
 * Ranked entities reduced to what a brief may say about them.
 *
 * Order is preserved, so a section is already highest-salience-first by the
 * time a cap is applied — which is what makes "the cap keeps the most salient"
 * true rather than a further sort someone has to remember.
 */
export function toSelected(scored: readonly Scored[]): readonly SelectedEntity[] {
  return scored.map((item) => ({
    entityId: item.subject.entity.id,
    name: nameOf(item.subject.entity),
    entityType: item.subject.entity.type,
    salience: item.score,
    facts: factsOf(item.subject.entity),
  }));
}

/**
 * The text an entity carries, as plain strings the generator can quote.
 *
 * Only fields with a single scalar value, and never `name` — which is carried
 * separately — nor `salience`, which is Otto's own bookkeeping rather than
 * something the note said. Set-valued fields are joined rather than dropped,
 * because `notes` is the escape hatch (`schema.md` §7) and is often where the
 * only interesting sentence lives.
 */
export function factsOf(entity: Entity): Readonly<Record<string, string>> {
  const facts: Record<string, string> = {};
  for (const [field, values] of Object.entries(entity.fields)) {
    if (EXCLUDED_FIELDS.includes(field)) continue;
    const rendered = values.map(renderValue).filter((value) => value.length > 0);
    if (rendered.length > 0) facts[field] = rendered.join("; ");
  }
  return facts;
}

/** Carried separately, or Otto's own bookkeeping rather than a fact about the world. */
const EXCLUDED_FIELDS: readonly string[] = ["name", "salience"];

/** A stored value as text: a date renders as the phrase the note used. */
function renderValue(value: Entity["fields"][string][number]): string {
  if (typeof value === "string") return value;
  return value.phrase.length > 0 ? value.phrase : (value.timestamp ?? "");
}

/** An entity's name, or its id when the projection somehow holds none. */
export function nameOf(entity: Entity): string {
  const name = entity.fields["name"]?.[0];
  return typeof name === "string" ? name : entity.id;
}

/** Whether `instant` is at or after `now` and no more than `days` beyond it. */
export function withinDays(instant: string, now: string, days: number): boolean {
  const until = daysBetween(now, instant);
  return until >= 0 && until <= days;
}

/** Whether `instant` falls in the `days` immediately before `now`. */
export function withinPastDays(instant: string, now: string, days: number): boolean {
  const elapsed = daysBetween(instant, now);
  return elapsed >= 0 && elapsed <= days;
}
