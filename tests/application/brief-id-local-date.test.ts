import { afterEach, describe, expect, it } from "vitest";
import { briefIdFor } from "../../src/application/pipeline/write-brief.js";

/**
 * A brief id names the local date it covers, at any UTC offset (Slice 12).
 *
 * The bug this pins is invisible at UTC and invisible in a suite that runs at a
 * negative offset. A brief produced at 06:00 local on a positive offset is
 * already the previous day in UTC, so a UTC-derived id names the day before the
 * one the brief is about — and since the id is also the idempotency key, the
 * next morning's brief would collide with it.
 *
 * The timezone is set explicitly rather than inherited, so the test means the
 * same thing on a laptop in California and in CI at UTC.
 */

const original = process.env.TZ;

afterEach(() => {
  setTimezone(original);
});

/**
 * `process.env.TZ` takes effect on the next `Date` constructed, which is enough
 * here because every assertion builds its dates after the assignment.
 */
function setTimezone(zone: string | undefined): void {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
}

describe("a brief id names the local date it covers", () => {
  /** 06:00 in Tokyo is 21:00 the previous day in UTC. */
  it("names today at a positive offset where UTC is still yesterday", () => {
    setTimezone("Asia/Tokyo");

    expect(briefIdFor("daily", "2026-08-01T21:00:00.000Z")).toBe("daily-2026-08-02");
  });

  /** 06:00 in Los Angeles is 13:00 the same day in UTC, so this one already passed. */
  it("names today at a negative offset where UTC agrees", () => {
    setTimezone("America/Los_Angeles");

    expect(briefIdFor("daily", "2026-08-02T13:00:00.000Z")).toBe("daily-2026-08-02");
  });

  /**
   * The negative-offset case where UTC has already rolled over: 23:00 local in
   * Los Angeles is 06:00 the next day in UTC.
   */
  it("names today at a negative offset where UTC is already tomorrow", () => {
    setTimezone("America/Los_Angeles");

    expect(briefIdFor("daily", "2026-08-03T06:00:00.000Z")).toBe("daily-2026-08-02");
  });

  it("names the same date the weekly brief covers", () => {
    setTimezone("Asia/Tokyo");

    expect(briefIdFor("weekly", "2026-08-02T21:00:00.000Z")).toBe("weekly-2026-08-03");
  });
});
