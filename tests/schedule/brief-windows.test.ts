import { afterEach, describe, expect, it } from "vitest";
import { dueBriefWindows } from "../../src/application/schedule/brief-windows.js";
import { localDateOf } from "../../src/application/schedule/local-time.js";

/**
 * Which brief windows an instant leaves outstanding (Slice 12).
 *
 * Dueness is derived rather than remembered: the scheduler stores nothing, and
 * a window is due when the trigger hour has passed for it and no brief is
 * stored for its date. That makes "ten ticks produce one brief" a property of
 * the stored briefs rather than of a flag the scheduler keeps, which is what
 * makes it survive a restart mid-morning.
 *
 * The timezone is pinned because every boundary here is a local one.
 */

const original = process.env.TZ;

afterEach(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

/** Nothing has ever been stored. */
const NONE_STORED = () => Promise.resolve(false);

/** Every window already has its brief. */
const ALL_STORED = () => Promise.resolve(true);

function setTimezone(zone: string): void {
  process.env.TZ = zone;
}

describe("the daily window", () => {
  it("is not due before the trigger hour", async () => {
    setTimezone("UTC");

    const windows = await dueBriefWindows("daily", "2026-08-02T05:59:00.000Z", NONE_STORED);

    expect(datesOf(windows)).not.toContain("2026-08-02");
  });

  it("is due on the first tick after the trigger hour with none stored", async () => {
    setTimezone("UTC");

    const windows = await dueBriefWindows("daily", "2026-08-02T06:00:00.000Z", NONE_STORED);

    expect(datesOf(windows)).toContain("2026-08-02");
  });

  /** The window covers its own morning, however late in the day it is noticed. */
  it("covers the trigger hour rather than the moment the tick happened", async () => {
    setTimezone("UTC");

    const windows = await dueBriefWindows("daily", "2026-08-02T15:30:00.000Z", NONE_STORED);

    expect(windows).toContain("2026-08-02T06:00:00.000Z");
  });

  it("is not due after the trigger hour once a brief is stored for the date", async () => {
    setTimezone("UTC");

    const windows = await dueBriefWindows("daily", "2026-08-02T09:00:00.000Z", ALL_STORED);

    expect(windows).toEqual([]);
  });

  /**
   * The trigger hour is local, so at a positive offset the window opens while
   * UTC is still on the previous date.
   */
  it("opens at the local trigger hour rather than the UTC one", async () => {
    setTimezone("Asia/Tokyo");

    // 05:00 and 06:00 on 2026-08-02 in Tokyo, both still 2026-08-01 in UTC.
    const early = await dueBriefWindows("daily", "2026-08-01T20:00:00.000Z", NONE_STORED);
    const due = await dueBriefWindows("daily", "2026-08-01T21:00:00.000Z", NONE_STORED);

    expect(datesOf(early)).not.toContain("2026-08-02");
    expect(datesOf(due)).toContain("2026-08-02");
  });
});

/** "Bounded to two days for daily briefs and one week for weekly." */
describe("catch-up after the application was closed", () => {
  it("produces a window for each of the two days a weekend missed", async () => {
    setTimezone("UTC");

    const windows = await dueBriefWindows("daily", "2026-08-02T09:00:00.000Z", NONE_STORED);

    expect(datesOf(windows)).toEqual(["2026-08-01", "2026-08-02"]);
  });

  it("produces the same bounded set after a month closed", async () => {
    setTimezone("UTC");

    const windows = await dueBriefWindows("daily", "2026-09-02T09:00:00.000Z", NONE_STORED);

    expect(datesOf(windows)).toEqual(["2026-09-01", "2026-09-02"]);
  });

  it("skips a window that already has its brief and keeps the one that does not", async () => {
    setTimezone("UTC");
    const storedYesterday = (covers: string) => Promise.resolve(covers.startsWith("2026-08-01"));

    const windows = await dueBriefWindows("daily", "2026-08-02T09:00:00.000Z", storedYesterday);

    expect(datesOf(windows)).toEqual(["2026-08-02"]);
  });

  it("orders the missed windows oldest first", async () => {
    setTimezone("UTC");

    const windows = await dueBriefWindows("daily", "2026-08-02T09:00:00.000Z", NONE_STORED);

    expect(windows[0]! < windows[1]!).toBe(true);
  });
});

describe("the weekly window", () => {
  /** 2026-08-03 is a Monday. */
  it("is due after the trigger hour on Monday", async () => {
    setTimezone("UTC");

    const windows = await dueBriefWindows("weekly", "2026-08-03T06:00:00.000Z", NONE_STORED);

    expect(datesOf(windows)).toContain("2026-08-03");
  });

  /**
   * Monday's own brief waits for the trigger hour, but the week before it is
   * still outstanding until then — a tick at 05:00 owes the previous Monday
   * rather than nothing.
   */
  it("is not due before the trigger hour on Monday", async () => {
    setTimezone("UTC");

    const windows = await dueBriefWindows("weekly", "2026-08-03T05:00:00.000Z", NONE_STORED);

    expect(datesOf(windows)).toEqual(["2026-07-27"]);
  });

  /**
   * The gap this covers: before the trigger hour on a Monday, the current
   * week's Monday is the only one a seven-day lookback reaches, and it has not
   * triggered yet. A brief missed the previous week is six days and eighteen
   * hours old — inside the bound — and was reachable at 23:00 the night before.
   * Without the eighth day it disappears at midnight and is skipped for good at
   * 06:00, which is a week's brief lost silently rather than a bound doing its
   * job.
   */
  it("still owes the previous Monday during Monday's small hours", async () => {
    setTimezone("UTC");

    const sunday = await dueBriefWindows("weekly", "2026-08-09T23:00:00.000Z", NONE_STORED);
    const monday = await dueBriefWindows("weekly", "2026-08-10T03:00:00.000Z", NONE_STORED);

    expect(datesOf(sunday)).toEqual(["2026-08-03"]);
    expect(datesOf(monday)).toEqual(["2026-08-03"]);
  });

  /** Tuesday still owes Monday's brief; the bound is one week back. */
  it("is due later in the week when Monday's brief was missed", async () => {
    setTimezone("UTC");

    const windows = await dueBriefWindows("weekly", "2026-08-05T09:00:00.000Z", NONE_STORED);

    expect(datesOf(windows)).toEqual(["2026-08-03"]);
  });

  it("produces at most one week's brief after a month closed", async () => {
    setTimezone("UTC");

    const windows = await dueBriefWindows("weekly", "2026-09-04T09:00:00.000Z", NONE_STORED);

    expect(datesOf(windows)).toEqual(["2026-08-31"]);
  });

  it("is not due once the week's brief is stored", async () => {
    setTimezone("UTC");

    const windows = await dueBriefWindows("weekly", "2026-08-03T09:00:00.000Z", ALL_STORED);

    expect(windows).toEqual([]);
  });

  /**
   * Exactly one Monday is due whatever day and hour it is read on, which is
   * what keeps a tick to one weekly brief.
   *
   * The eight-day lookback holds two Mondays on a Monday, and the trigger-hour
   * check is what resolves them to one: before 06:00 the current week's has not
   * opened and the previous week's is owed, after 06:00 the reverse. Reading
   * every hour rather than one is what distinguishes that from a bound that
   * simply empties.
   */
  it("finds exactly one Monday at every hour of every day of the week", async () => {
    setTimezone("UTC");

    for (let day = 2; day <= 8; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const at = `2026-08-0${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
        expect(await dueBriefWindows("weekly", at, NONE_STORED)).toHaveLength(1);
      }
    }
  });
});

/** The local date each window covers, which is what its brief id names. */
function datesOf(windows: readonly string[]): readonly string[] {
  return windows.map(localDateOf);
}
