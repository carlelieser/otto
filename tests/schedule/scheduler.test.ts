import { describe, expect, it, vi } from "vitest";
import { Scheduler, type ScheduledTask } from "../../src/application/schedule/scheduler.js";

/**
 * The tick loop: what runs, what happens when one task throws, and what a
 * quiet tick says (Slice 12).
 *
 * Every test drives `tick` directly rather than waiting on a timer. The loop's
 * job is to decide what runs and to survive what fails, and a test that slept
 * for an interval would be testing `setInterval`.
 */

/** A task that records each time it ran. */
function recording(name: string, runs: string[]): ScheduledTask {
  return {
    name,
    run: async (now) => {
      runs.push(now);
    },
  };
}

/** A task that always throws. */
function failing(name: string): ScheduledTask {
  return {
    name,
    run: async () => {
      throw new Error(`${name} failed`);
    },
  };
}

describe("a tick", () => {
  it("runs every task with the current instant", async () => {
    const runs: string[] = [];
    const scheduler = new Scheduler({
      tasks: [recording("projection", runs)],
      now: () => "2026-08-02T06:00:00.000Z",
    });

    await scheduler.tick();

    expect(runs).toEqual(["2026-08-02T06:00:00.000Z"]);
  });

  it("runs each task once per tick", async () => {
    const runs: string[] = [];
    const scheduler = new Scheduler({
      tasks: [recording("a", runs), recording("b", runs)],
      now: () => "2026-08-02T06:00:00.000Z",
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(runs).toHaveLength(4);
  });
});

/**
 * "A task that throws does not prevent other tasks in the same tick, or itself
 * in the next window" — `qa.md` §9's requirement that an unavailable LLM costs
 * timeliness rather than data.
 */
describe("a failing task", () => {
  it("does not stop the tasks after it in the same tick", async () => {
    const runs: string[] = [];
    const scheduler = new Scheduler({
      tasks: [failing("briefs"), recording("projection", runs)],
      now: () => "2026-08-02T06:00:00.000Z",
      report: () => {},
    });

    await scheduler.tick();

    expect(runs).toHaveLength(1);
  });

  it("does not reject the tick it failed in", async () => {
    const scheduler = new Scheduler({
      tasks: [failing("briefs")],
      now: () => "2026-08-02T06:00:00.000Z",
      report: () => {},
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  it("is attempted again on the next tick", async () => {
    let attempts = 0;
    const scheduler = new Scheduler({
      tasks: [
        {
          name: "briefs",
          run: async () => {
            attempts += 1;
            throw new Error("still failing");
          },
        },
      ],
      now: () => "2026-08-02T06:00:00.000Z",
      report: () => {},
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(attempts).toBe(2);
  });

  it("reports the failure with the name of the task that failed", async () => {
    const reported: string[] = [];
    const scheduler = new Scheduler({
      tasks: [failing("briefs")],
      now: () => "2026-08-02T06:00:00.000Z",
      report: (message) => reported.push(message),
    });

    await scheduler.tick();

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("briefs");
  });
});

/** "A tick with no due work logs nothing." */
describe("an idle tick", () => {
  it("reports nothing when every task succeeds", async () => {
    const reported: string[] = [];
    const scheduler = new Scheduler({
      tasks: [recording("projection", [])],
      now: () => "2026-08-02T06:00:00.000Z",
      report: (message) => reported.push(message),
    });

    await scheduler.tick();

    expect(reported).toEqual([]);
  });
});

describe("the loop", () => {
  it("ticks on the interval it was given", async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const scheduler = new Scheduler({
      tasks: [recording("projection", runs)],
      now: () => "2026-08-02T06:00:00.000Z",
      intervalMs: 1_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(3_000);
    scheduler.stop();
    vi.useRealTimers();

    expect(runs.length).toBeGreaterThanOrEqual(3);
  });

  it("stops ticking once stopped", async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const scheduler = new Scheduler({
      tasks: [recording("projection", runs)],
      now: () => "2026-08-02T06:00:00.000Z",
      intervalMs: 1_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(2_000);
    scheduler.stop();
    const after = runs.length;
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();

    expect(runs).toHaveLength(after);
  });

  /** Starting twice must not leave a second interval nobody can stop. */
  it("does not start a second loop when already running", async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const scheduler = new Scheduler({
      tasks: [recording("projection", runs)],
      now: () => "2026-08-02T06:00:00.000Z",
      intervalMs: 1_000,
    });

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(2_000);
    scheduler.stop();
    const after = runs.length;
    await vi.advanceTimersByTimeAsync(3_000);
    vi.useRealTimers();

    expect(runs).toHaveLength(after);
  });
});
