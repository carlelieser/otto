import type { Entity } from "../../domain/knowledge/entity.js";
import { isTimeOrdered, type ResolvedDate } from "../../domain/values/resolved-date.js";
import type { SalienceCoefficients, Step } from "./coefficients.js";
import { statusOf, type SalientEntity } from "./salient-entity.js";

/**
 * The five terms of `salience.md` §2, one function each.
 *
 * Separate functions rather than one scorer with five branches, because
 * `qa.md` §11 asks that **each term is tested in isolation** — and because the
 * legibility ADR-0015 makes an architectural requirement is a property of the
 * code as much as of the score: a reader asking why something ranked high
 * should find five named answers rather than one expression.
 *
 * Every term takes its coefficients as an argument. None reads a clock: `now`
 * is passed in, which is what makes a fixture with a known mention date score
 * to a fixed number rather than to whatever today is.
 */

/** The statuses `dormancy` treats as closed (`salience.md` §2). */
const CLOSED_STATUSES: readonly string[] = ["done", "dropped", "abandoned"];

/** The Project statuses that count as an open loop. */
const OPEN_PROJECT_STATUSES: readonly string[] = ["active", "blocked"];

/** The date field each type carries, for `imminence`. */
const DATE_FIELDS: Readonly<Record<string, string>> = {
  Event: "occurred_at",
  Task: "due",
  Project: "due",
};

/**
 * How recently a Capture mentioned it: linear decay from 40 at today to 0 at 30
 * days, and 0 beyond.
 *
 * The single largest term, "because the thing the user just wrote about is
 * usually the thing on their mind" — and, by `salience.md` §3's own admission,
 * the term most likely to dominate wrongly. It is written to be easy to
 * re-weight for exactly that reason.
 *
 * A mention in the future scores the full 40 rather than more: clock skew
 * between the log and the caller is real and should not manufacture salience.
 */
export function recency(
  entity: SalientEntity,
  now: string,
  coefficients: SalienceCoefficients,
): number {
  const { atToday, overDays } = coefficients.recency;
  const elapsed = daysBetween(entity.lastMentionedAt, now);
  if (elapsed <= 0) return atToday;
  if (elapsed >= overDays) return 0;
  return atToday * (1 - elapsed / overDays);
}

/**
 * 25 for a Project that is active or blocked, 25 for an open Task, 0 otherwise.
 *
 * "An entity with nothing outstanding is not competing for attention." An Idea
 * scores nothing here even when its status is `open`: `salience.md` §2 names
 * Projects and Tasks, and an Idea is by definition the thing not yet committed
 * to.
 */
export function openLoop(entity: Entity, coefficients: SalienceCoefficients): number {
  return isOpenLoop(entity) ? coefficients.openLoop : 0;
}

/** Whether this entity is the kind of open thing `open_loop` and the briefs mean. */
export function isOpenLoop(entity: Entity): boolean {
  const status = statusOf(entity);
  if (entity.type === "Project")
    return status !== undefined && OPEN_PROJECT_STATUSES.includes(status);
  return entity.type === "Task" && status === "open";
}

/**
 * How close a carried date is: 30 within 2 days, 20 within a week, 10 within a
 * month, 0 beyond.
 *
 * **A past-dated open item keeps 30 until it is closed**, "because a missed
 * deadline is more salient than an upcoming one, not less". That asymmetry is
 * the one piece of judgement in this term, and it is why the overdue case is a
 * named coefficient rather than falling out of the bands.
 *
 * A `relative_unresolved` date scores nothing: it carries no instant, and
 * `schema.md` §8 excludes it from everything time-ordered.
 */
export function imminence(entity: Entity, now: string, coefficients: SalienceCoefficients): number {
  const date = dateBorneBy(entity);
  if (date === undefined || !isTimeOrdered(date) || date.timestamp === null) return 0;
  const until = daysBetween(now, date.timestamp);
  if (until < 0) return isClosed(entity) ? 0 : coefficients.overdue;
  return bandFor(until, coefficients.imminence);
}

/**
 * 15 for a blocked Project unmentioned in 14 days, 15 for an open Task
 * unmentioned in 30.
 *
 * **The term that justifies the feature.** It surfaces what the user has
 * quietly stopped thinking about, "which is the one thing a system like this
 * can do that the user cannot do for themselves" — everything else here
 * re-ranks things they would have remembered anyway.
 *
 * It is also what the daily brief's "Looks stuck" section selects on, which is
 * why this returns the points rather than a boolean and `firesAttentionDebt`
 * asks the question separately.
 */
export function attentionDebt(
  entity: SalientEntity,
  now: string,
  coefficients: SalienceCoefficients,
): number {
  return firesAttentionDebt(entity, now, coefficients) ? coefficients.attentionDebt.points : 0;
}

/** Whether the debt term fired, which is also "Looks stuck"'s membership test. */
export function firesAttentionDebt(
  entity: SalientEntity,
  now: string,
  coefficients: SalienceCoefficients,
): boolean {
  const silence = requiredSilence(entity.entity, coefficients);
  return silence !== undefined && daysBetween(entity.lastMentionedAt, now) >= silence;
}

/** How long this entity must go unmentioned before the debt term fires. */
function requiredSilence(entity: Entity, coefficients: SalienceCoefficients): number | undefined {
  const { blockedProjectSilentDays, openTaskSilentDays } = coefficients.attentionDebt;
  const status = statusOf(entity);
  if (entity.type === "Project" && status === "blocked") return blockedProjectSilentDays;
  return entity.type === "Task" && status === "open" ? openTaskSilentDays : undefined;
}

/**
 * Subtracts 20 from anything closed, and from an Event more than 7 days past
 * with an `outcome`.
 *
 * "Closed things sink" — sink rather than disappear, which is the point of
 * subtracting rather than filtering. A Project closed this morning is still
 * worth mentioning today, and the recency term outweighs this one for about a
 * fortnight.
 */
export function dormancy(entity: Entity, now: string, coefficients: SalienceCoefficients): number {
  return isDormant(entity, now, coefficients) ? coefficients.dormancy.points : 0;
}

function isDormant(entity: Entity, now: string, coefficients: SalienceCoefficients): boolean {
  return isClosed(entity) || isSettledEvent(entity, now, coefficients);
}

/** Whether the entity's status is one of the three `salience.md` §2 calls closed. */
export function isClosed(entity: Entity): boolean {
  const status = statusOf(entity);
  return status !== undefined && CLOSED_STATUSES.includes(status);
}

/**
 * An Event far enough past to have an outcome, and carrying one.
 *
 * Both halves are required: a past Event nobody recorded an outcome for is
 * unfinished business rather than a closed thing, and sinking it is how the
 * meeting the user never wrote up disappears.
 */
function isSettledEvent(entity: Entity, now: string, coefficients: SalienceCoefficients): boolean {
  if (entity.type !== "Event" || entity.fields["outcome"] === undefined) return false;
  const date = dateBorneBy(entity);
  if (date?.timestamp == null || !isTimeOrdered(date)) return false;
  return daysBetween(date.timestamp, now) > coefficients.dormancy.settledEventDays;
}

/** The date this entity type carries, or `undefined` when it carries none. */
export function dateBorneBy(entity: Entity): ResolvedDate | undefined {
  const field = DATE_FIELDS[entity.type];
  if (field === undefined) return undefined;
  const value = entity.fields[field]?.[0];
  return typeof value === "object" ? value : undefined;
}

/** The first band `days` falls within, or 0 when it falls outside every one. */
function bandFor(days: number, steps: readonly Step[]): number {
  return steps.find((step) => days <= step.days)?.points ?? 0;
}

/**
 * Whole and fractional days from `from` to `to`, negative when `to` is earlier.
 *
 * Fractional rather than rounded, so `recency` decays smoothly instead of in
 * 24-hour steps — a score that jumps at midnight would make two briefs an hour
 * apart disagree for a reason no reader could see.
 */
export function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / MILLISECONDS_PER_DAY;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
