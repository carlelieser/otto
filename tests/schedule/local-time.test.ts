import { afterEach, describe, expect, it } from "vitest";
import { daysEarlier, localDateOf } from "../../src/application/schedule/local-time.js";
import { dueBriefWindows } from "../../src/application/schedule/brief-windows.js";

/**
 * Stepping back a day is a calendar step, not a 24-hour one (Slice 12).
 *
 * `daysEarlier` sets the local date component rather than subtracting
 * milliseconds, which matters only on the four instants a year a zone's offset
 * changes. Those instants are exactly where a catch-up walk runs during a
 * transition, so the distinction is worth pinning: subtracting 24 hours across a
 * transition lands an hour either side of where it started, and the local date
 * that comes back is the wrong one.
 *
 * Without these, the naive implementation passes the entire suite.
 *
 * The timezone is set explicitly rather than inherited, so the test means the
 * same thing on a laptop in California and in CI at UTC.
 */

const original = process.env.TZ;

afterEach(() => {
  setTimezone(original);
});

function setTimezone(zone: string | undefined): void {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
}

const NONE_STORED = () => Promise.resolve(false);

describe("stepping back a day across a DST transition", () => {
  /**
   * 2026-11-01 is the autumn transition in Los Angeles, where 01:00 local
   * happens twice. A 24-hour subtraction from 23:15 that evening lands back on
   * the same local date, so the walk returns 11-01 twice and the window for
   * 10-31 is silently dropped.
   */
  it("lands on the previous local date when the day is 25 hours long", () => {
    setTimezone("America/Los_Angeles");

    const evening = "2026-11-02T07:15:00.000Z";

    expect(localDateOf(evening)).toBe("2026-11-01");
    expect(localDateOf(daysEarlier(evening, 1))).toBe("2026-10-31");
  });

  /**
   * 2026-03-08 is the spring transition, where 02:00 local does not exist and
   * the day is 23 hours long. A 24-hour subtraction from just after midnight on
   * the 9th overshoots into the 7th.
   */
  it("lands on the previous local date when the day is 23 hours long", () => {
    setTimezone("America/Los_Angeles");

    const afterMidnight = "2026-03-09T08:15:00.000Z";

    expect(localDateOf(afterMidnight)).toBe("2026-03-09");
    expect(localDateOf(daysEarlier(afterMidnight, 1))).toBe("2026-03-08");
  });

  /** The southern-hemisphere direction, where the transition runs the other way. */
  it("lands on the previous local date in a zone transitioning in April", () => {
    setTimezone("Australia/Sydney");

    const evening = "2026-04-05T12:15:00.000Z";

    expect(localDateOf(evening)).toBe("2026-04-05");
    expect(localDateOf(daysEarlier(evening, 1))).toBe("2026-04-04");
  });

  /**
   * The consequence at the level the scheduler cares about: two distinct daily
   * windows rather than the same date twice. Under a 24-hour step this returns
   * `["2026-11-01", "2026-11-01"]`, which is one window lost and two `produce`
   * calls for one brief id.
   */
  it("gives the catch-up walk two distinct dates across the transition", async () => {
    setTimezone("America/Los_Angeles");

    const windows = await dueBriefWindows("daily", "2026-11-02T07:15:00.000Z", NONE_STORED);

    expect(windows.map(localDateOf)).toEqual(["2026-10-31", "2026-11-01"]);
  });

  /**
   * The weekly kind fails differently: a step that lands an hour early walks
   * past Monday entirely, so the walk finds no Monday and returns nothing.
   */
  it("still finds the Monday when the walk crosses a transition", async () => {
    setTimezone("America/Los_Angeles");

    const windows = await dueBriefWindows("weekly", "2026-11-02T07:15:00.000Z", NONE_STORED);

    expect(windows.map(localDateOf)).toEqual(["2026-10-26"]);
  });
});

describe("stepping back a day across a month and a year boundary", () => {
  it("crosses into the previous month", () => {
    setTimezone("UTC");

    expect(localDateOf(daysEarlier("2026-09-01T09:00:00.000Z", 1))).toBe("2026-08-31");
  });

  it("crosses into the previous year", () => {
    setTimezone("UTC");

    expect(localDateOf(daysEarlier("2026-01-01T09:00:00.000Z", 1))).toBe("2025-12-31");
  });
});
