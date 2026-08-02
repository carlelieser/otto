import type { BriefKind } from "../../inference/salience/brief-selection.js";
import { daysEarlier, localDateOf, localHourOf, localWeekdayOf } from "./local-time.js";

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
  for (let back = 0; back < CATCH_UP_DAYS[kind]; back += 1) {
    const covers = daysEarlier(now, back);
    if (hasTriggered(kind, covers, now)) windows.push(triggerInstantOf(covers));
  }
  return windows.reverse();
}

/**
 * Whether the window covering `covers` has opened by `now`.
 *
 * A past day's window opened whenever its trigger hour arrived, so only the
 * current day has to be checked against the hour. The weekly kind additionally
 * has to fall on its weekday, which is what makes a Tuesday tick that missed
 * Monday find Monday's window rather than Tuesday's.
 */
function hasTriggered(kind: BriefKind, covers: string, now: string): boolean {
  if (kind === "weekly" && localWeekdayOf(covers) !== WEEKLY_DAY) return false;
  if (localDateOf(covers) !== localDateOf(now)) return true;
  return localHourOf(now) >= TRIGGER_HOUR;
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
function triggerInstantOf(covers: string): string {
  const at = new Date(covers);
  at.setHours(TRIGGER_HOUR, 0, 0, 0);
  return at.toISOString();
}
