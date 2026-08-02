import type { Entity } from "../../domain/knowledge/entity.js";
import { V0_COEFFICIENTS, type SalienceCoefficients } from "./coefficients.js";
import {
  sectionOf,
  type BriefSection,
  type BriefSelection,
  type SelectedEntity,
} from "./brief-selection.js";
import { rankAndPair, toSelected, withinDays, type Scored } from "./selection-support.js";
import type { SalientEntity } from "./salient-entity.js";
import { dateBorneBy, daysBetween, firesAttentionDebt, isClosed, isOpenLoop } from "./terms.js";
import type { Relation } from "../../domain/knowledge/relation.js";

/**
 * The daily brief's four sections (`salience.md` §4).
 *
 * | Section | Selection | Cap |
 * |---|---|---|
 * | Today | Events occurring today; Tasks due today or overdue | 8 |
 * | Worth doing | Highest-salience open Tasks and Project `next_action`s not already listed | 5 |
 * | Looks stuck | Entities where `attention_debt` fired | 3 |
 * | Coming up | Events and due dates within 7 days, excluding today | 5 |
 *
 * Readable in under two minutes (PRD §5.7), which is what the caps enforce.
 * **Empty sections are omitted rather than padded**, and a brief that selects
 * nothing returns no sections at all — the quiet day is a legitimate output,
 * not a failure to find something.
 */

/** The caps, transcribed from `salience.md` §4's table. */
export const DAILY_CAPS = { today: 8, worthDoing: 5, looksStuck: 3, comingUp: 5 } as const;

/** How far ahead "Coming up" looks. */
const COMING_UP_DAYS = 7;

export function selectDaily(
  entities: readonly SalientEntity[],
  relations: readonly Relation[],
  now: string,
  coefficients: SalienceCoefficients = V0_COEFFICIENTS,
): BriefSelection {
  const scored = rankAndPair(entities, relations, now, coefficients);
  return {
    kind: "daily",
    coversFrom: startOfDay(now),
    coversTo: now,
    sections: dailySections(scored, now, coefficients),
  };
}

/** The four sections in reading order, each dropped when it selected nothing. */
function dailySections(
  scored: readonly Scored[],
  now: string,
  coefficients: SalienceCoefficients,
): readonly BriefSection[] {
  const today = toSelected(scored.filter((item) => isDueToday(item, now)));
  const listed = new Set(today.map((entity) => entity.entityId));
  return [
    ...sectionOf("Today", today, DAILY_CAPS.today),
    ...sectionOf("Worth doing", worthDoing(scored, listed), DAILY_CAPS.worthDoing),
    ...sectionOf("Looks stuck", looksStuck(scored, now, coefficients), DAILY_CAPS.looksStuck),
    ...sectionOf("Coming up", comingUp(scored, now), DAILY_CAPS.comingUp),
  ];
}

/**
 * Events occurring today, and Tasks due today or already overdue.
 *
 * An overdue Task belongs here rather than in a section of its own, for the
 * reason `imminence` keeps its 30: a missed deadline is today's problem.
 */
function isDueToday({ subject }: Scored, now: string): boolean {
  const date = dateBorneBy(subject.entity);
  if (date?.timestamp == null) return false;
  const days = daysBetween(now, date.timestamp);
  if (subject.entity.type === "Task") return !isClosed(subject.entity) && days < 1;
  return subject.entity.type === "Event" && isSameDay(date.timestamp, now);
}

/**
 * The highest-salience open Tasks and Projects carrying a `next_action`, minus
 * anything "Today" already listed.
 *
 * The exclusion is what stops the two top sections restating each other, which
 * on a busy day would spend half the two-minute budget saying one thing twice.
 */
function worthDoing(
  scored: readonly Scored[],
  listed: ReadonlySet<string>,
): readonly SelectedEntity[] {
  return toSelected(
    scored.filter(
      (item) => !listed.has(item.subject.entity.id) && isActionable(item.subject.entity),
    ),
  );
}

/** An open Task, or a Project that says what its next action is. */
function isActionable(entity: Entity): boolean {
  if (entity.type === "Task") return isOpenLoop(entity);
  return entity.type === "Project" && entity.fields["next_action"] !== undefined;
}

/**
 * Whatever `attention_debt` fired on — the section that justifies the feature.
 *
 * It surfaces what the user has quietly stopped thinking about, and it is the
 * one section whose membership is a term rather than a query, which is why it
 * shares `firesAttentionDebt` with the scorer instead of restating the rule.
 */
function looksStuck(
  scored: readonly Scored[],
  now: string,
  coefficients: SalienceCoefficients,
): readonly SelectedEntity[] {
  return toSelected(scored.filter((item) => firesAttentionDebt(item.subject, now, coefficients)));
}

/** Events and due dates inside the next week, excluding today's. */
function comingUp(scored: readonly Scored[], now: string): readonly SelectedEntity[] {
  return toSelected(
    scored.filter((item) => {
      const date = dateBorneBy(item.subject.entity);
      if (date?.timestamp == null || isClosed(item.subject.entity)) return false;
      return !isSameDay(date.timestamp, now) && withinDays(date.timestamp, now, COMING_UP_DAYS);
    }),
  );
}

/** Whether two instants fall on the same UTC day. */
function isSameDay(left: string, right: string): boolean {
  return startOfDay(left) === startOfDay(right);
}

/** The UTC date `instant` falls on, as `YYYY-MM-DD`. */
function startOfDay(instant: string): string {
  return new Date(instant).toISOString().slice(0, 10);
}
