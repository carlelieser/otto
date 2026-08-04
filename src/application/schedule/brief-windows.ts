import type { BriefKind } from "../../inference/salience/brief-selection.js";
import { daysEarlier, localHourOf, localWeekdayOf } from "./local-time.js";

/**
 * Which brief windows an instant leaves outstanding (Slice 12).
 *
 * **Dueness is derived, never remembered.** The scheduler stores nothing of its
 * own: a window is due when its trigger has passed and no brief is stored for
 * the date it covers, both of which are readable at any moment from the
 * `briefs` table. That is what makes ten ticks produce one brief without a flag
 * to keep in sync, and what makes a restart mid-morning resume correctly rather
 * than either re-firing or going quiet for the day.
 *
 * A window is identified by the instant it covers, because that is what both
 * `readSalientEntities` and `briefIdFor` take. Producing a missed window is
 * therefore an ordinary call with a past timestamp rather than a second code
 * path — the property that keeps catch-up from being its own feature.
 */

/**
 * The hour a brief becomes due, local (Slice 12: "the first tick after 06:00
 * local time").
 *
 * A constant rather than a setting. PRD §7.2 places brief customisation
 * post-MVP, and whether 06:00 is the right hour is a product question that
 * `salience.md` §5's instrumentation answers by measuring whether briefs get
 * read — not one a test can settle.
 */
const TRIGGER_HOUR = 6;

/** The weekday the weekly brief covers, Monday, in `Date`'s numbering. */
const WEEKLY_DAY = 1;

/**
 * How far back a missed window is still produced, per kind.
 *
 * PRD §4.7 requires that a week away creates no backlog to clear. Unbounded
 * catch-up would answer a month's absence with thirty model calls and thirty
 * briefs about days the user has stopped caring about, which is the backlog
 * rather than the absence of one. **Older windows are skipped permanently**:
 * nothing records that they were missed, because the brief that would have been
 * written is the only thing that would have recorded it.
 *
 * The bound counts windows that have opened rather than calendar days back
 * from the tick. Before the trigger hour the current day's window has not
 * opened, so the span starts at yesterday and reaches one day further back —
 * which is what keeps a Monday at 03:00 owing the previous Monday rather than
 * nothing, without owing two once 06:00 has passed.
 */
const CATCH_UP_DAYS: Readonly<Record<BriefKind, number>> = { daily: 2, weekly: 7 };

/** Whether a brief is already stored for the window covering this instant. */
export type BriefExists = (covers: string) => Promise<boolean>;

/**
 * The windows of `kind` that are due at `now`, oldest first.
 *
 * Oldest first so that a catch-up run produces the missed briefs in the order
 * they were missed, which is the order the dashboard lists them in.
 */
export async function dueBriefWindows(
  kind: BriefKind,
  now: string,
  exists: BriefExists,
): Promise<readonly string[]> {
  const due: string[] = [];
  for (const covers of candidateWindows(kind, now)) {
    if (!(await exists(covers))) due.push(covers);
  }
  return due;
}

/**
 * Every window of `kind` whose trigger has passed, within the catch-up bound.
 *
 * Walks back a day at a time from `now` rather than computing dates directly,
 * so a step across a month, a year, or a DST transition is `Date`'s arithmetic
 * rather than this module's.
 */
function candidateWindows(kind: BriefKind, now: string): readonly string[] {
  const windows: string[] = [];
  const opened = mostRecentOpenDay(now);
  for (let back = 0; back < CATCH_UP_DAYS[kind]; back += 1) {
    const day = daysEarlier(opened, back);
    if (fallsOnWindowDay(kind, day)) windows.push(triggerInstantOf(day));
  }
  return windows.reverse();
}

/**
 * The latest day whose trigger hour has passed: today once it has, else
 * yesterday.
 *
 * Anchoring the walk here rather than at the tick's own date is what makes the
 * bound count opened windows rather than calendar days. Anchored at the tick,
 * the pre-06:00 hours lose their oldest window — for the weekly kind that is
 * every window, because the only Monday a seven-day span then reaches is
 * today's, which has not opened.
 */
function mostRecentOpenDay(now: string): string {
  return localHourOf(now) >= TRIGGER_HOUR ? now : daysEarlier(now, 1);
}

/**
 * Whether a window of `kind` falls on this day at all.
 *
 * Every day carries a daily window; only Monday carries a weekly one, which is
 * what makes a Tuesday tick that missed Monday find Monday's window rather than
 * Tuesday's. Whether the window has *opened* is already settled by the anchor,
 * so the hour is not read here.
 */
function fallsOnWindowDay(kind: BriefKind, day: string): boolean {
  return kind !== "weekly" || localWeekdayOf(day) === WEEKLY_DAY;
}

/**
 * The instant a window's brief is produced for: its own date at the trigger
 * hour.
 *
 * Normalised to the trigger hour rather than left as the tick's own timestamp,
 * so a missed window covers the same span however late it is noticed — a brief
 * produced at Tuesday lunchtime for Monday scores Monday's log, not Monday's
 * log plus a day and a half of it.
 */
function triggerInstantOf(day: string): string {
  const at = new Date(day);
  at.setHours(TRIGGER_HOUR, 0, 0, 0);
  return at.toISOString();
}
