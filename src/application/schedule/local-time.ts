/**
 * The local calendar, read off an instant (Slice 12).
 *
 * Every wall-clock decision Otto makes is about the user's day rather than
 * about UTC's: a brief due "after 06:00" is due after the user's breakfast, and
 * a brief covering "today" names the date on the user's calendar. At a positive
 * UTC offset those two are a different day from UTC's, and deriving either from
 * `toISOString` names the adjacent one.
 *
 * The zone is the host's, read implicitly by `Date`'s local accessors, and is
 * deliberately not configurable — Otto is a local-first single-user application
 * (PRD §4.6) and the machine's zone is the user's zone. A test pins it with
 * `process.env.TZ`.
 */

/**
 * The local calendar date of an instant, as `YYYY-MM-DD`.
 *
 * Built from the local accessors rather than by shifting the timestamp and
 * slicing an ISO string, because a fixed offset is wrong twice a year: the
 * accessors ask the zone, which knows about DST, and an arithmetic shift does
 * not.
 */
export function localDateOf(instant: string): string {
  const at = new Date(instant);
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

/** The local hour of an instant, 0–23. */
export function localHourOf(instant: string): number {
  return new Date(instant).getHours();
}

/** The local day of the week, 0 for Sunday through 6 for Saturday. */
export function localWeekdayOf(instant: string): number {
  return new Date(instant).getDay();
}

/**
 * The same local time of day, `days` days earlier.
 *
 * Built by decrementing the local date component rather than by subtracting
 * multiples of 24 hours: across a DST transition a 24-hour step lands an hour
 * either side of where it started, which over a week's catch-up accumulates
 * into a step that lands on the wrong date entirely. Setting the date component
 * asks the zone to resolve the local time, which is the arithmetic the user's
 * calendar actually does.
 *
 * The date is set before anything reads it back, so `Date`'s own normalisation
 * handles a step across a month or year boundary.
 */
export function daysEarlier(instant: string, days: number): string {
  const at = new Date(instant);
  at.setDate(at.getDate() - days);
  return at.toISOString();
}
