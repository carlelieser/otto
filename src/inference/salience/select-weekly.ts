import type { Relation } from "../../domain/knowledge/relation.js";
import { V0_COEFFICIENTS, type SalienceCoefficients } from "./coefficients.js";
import {
  sectionOf,
  type BriefSection,
  type BriefSelection,
  type SelectedEntity,
} from "./brief-selection.js";
import { activityOf, type SalientEntity } from "./salient-entity.js";
import { rankAndPair, toSelected, withinPastDays, type Scored } from "./selection-support.js";
import { isOpenLoop } from "./terms.js";

/**
 * The weekly brief's five sections (`salience.md` §4).
 *
 * | Section | Selection | Cap |
 * |---|---|---|
 * | What moved | Status changes, or ≥3 change events this week | 8 |
 * | What didn't | `open_loop` entities with no events this week and none last week | 5 |
 * | Open loops | Highest-salience open Tasks and blocked Projects | 8 |
 * | New this week | Entities created this week | 10 |
 * | People | Persons mentioned this week, and long-silent former regulars | 6 |
 *
 * Broader than the daily brief, and **about change rather than state** — which
 * is what the event log makes cheap and a pile of notes does not. Three of the
 * five sections read `activity` rather than the entity, because a folded entity
 * has had its history reduced away by design.
 */

/** The caps, transcribed from `salience.md` §4's table. */
export const WEEKLY_CAPS = {
  whatMoved: 8,
  whatDidnt: 5,
  openLoops: 8,
  newThisWeek: 10,
  people: 6,
} as const;

/** The window a weekly brief covers. */
const WEEK_DAYS = 7;

/** How many changes make an entity "moved" absent a status change. */
const BUSY_CHANGES = 3;

/**
 * How long a former regular must be silent to be worth resurfacing.
 *
 * `salience.md` §4 calls the People row "the one most likely to justify the
 * whole feature, and also the most likely to be annoying. It is worth
 * watching" — which is what the instrumentation is for.
 */
const LAPSED_CONTACT_DAYS = 60;

/** How many mentions make someone a former regular rather than a passing name. */
const PREVIOUSLY_FREQUENT = 3;

export function selectWeekly(
  entities: readonly SalientEntity[],
  relations: readonly Relation[],
  now: string,
  coefficients: SalienceCoefficients = V0_COEFFICIENTS,
): BriefSelection {
  const scored = rankAndPair(entities, relations, now, coefficients);
  return {
    kind: "weekly",
    coversFrom: daysBefore(now, WEEK_DAYS),
    coversTo: now,
    sections: weeklySections(scored, now),
  };
}

/** The five sections in reading order, each dropped when it selected nothing. */
function weeklySections(scored: readonly Scored[], now: string): readonly BriefSection[] {
  return [
    ...sectionOf("What moved", whatMoved(scored), WEEKLY_CAPS.whatMoved),
    ...sectionOf("What didn't", whatDidnt(scored), WEEKLY_CAPS.whatDidnt),
    ...sectionOf("Open loops", openLoops(scored), WEEKLY_CAPS.openLoops),
    ...sectionOf("New this week", newThisWeek(scored, now), WEEKLY_CAPS.newThisWeek),
    ...sectionOf("People", people(scored, now), WEEKLY_CAPS.people),
  ];
}

/** Entities with a status change this week, or at least three changes of any kind. */
function whatMoved(scored: readonly Scored[]): readonly SelectedEntity[] {
  return toSelected(
    scored.filter((item) => {
      const activity = activityOf(item.subject);
      return activity.statusChanged || activity.changesThisWeek >= BUSY_CHANGES;
    }),
  );
}

/**
 * Open loops the log did not touch this week or last.
 *
 * Two weeks of silence rather than one, because a single quiet week is an
 * ordinary thing that happens to healthy work and reporting it weekly would
 * make the section noise.
 */
function whatDidnt(scored: readonly Scored[]): readonly SelectedEntity[] {
  return toSelected(
    scored.filter((item) => {
      const activity = activityOf(item.subject);
      return (
        isOpenLoop(item.subject.entity) &&
        activity.changesThisWeek === 0 &&
        activity.changesLastWeek === 0
      );
    }),
  );
}

/**
 * The highest-salience open Tasks and blocked Projects.
 *
 * State rather than change, and the one section that overlaps the daily brief
 * on purpose: a weekly brief that never restated the outstanding work would
 * make the reader reconstruct it from seven dailies.
 */
function openLoops(scored: readonly Scored[]): readonly SelectedEntity[] {
  return toSelected(scored.filter((item) => isOpenLoop(item.subject.entity)));
}

function newThisWeek(scored: readonly Scored[], now: string): readonly SelectedEntity[] {
  return toSelected(
    scored.filter((item) => withinPastDays(item.subject.createdAt, now, WEEK_DAYS)),
  );
}

/**
 * Persons mentioned this week, and those with no contact in 60 days who were
 * previously frequent.
 *
 * The second half is the part that could be either the most valuable thing the
 * brief does or the most irritating, and `salience.md` §4 says so. The
 * `PREVIOUSLY_FREQUENT` floor is what keeps it from resurfacing everyone the
 * user ever named once.
 */
function people(scored: readonly Scored[], now: string): readonly SelectedEntity[] {
  return toSelected(
    scored.filter(
      (item) =>
        item.subject.entity.type === "Person" &&
        (mentionedThisWeek(item.subject, now) || isLapsedRegular(item.subject, now)),
    ),
  );
}

function mentionedThisWeek(subject: SalientEntity, now: string): boolean {
  return withinPastDays(subject.lastMentionedAt, now, WEEK_DAYS);
}

/** Silent for 60 days, and mentioned enough before that to have been a regular. */
function isLapsedRegular(subject: SalientEntity, now: string): boolean {
  const lapsed = !withinPastDays(subject.lastMentionedAt, now, LAPSED_CONTACT_DAYS);
  return lapsed && activityOf(subject).changesEver >= PREVIOUSLY_FREQUENT;
}

/** `days` before `instant`, ISO 8601. */
function daysBefore(instant: string, days: number): string {
  return new Date(Date.parse(instant) - days * 24 * 60 * 60 * 1000).toISOString();
}
