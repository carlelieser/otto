import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scheduledTasks } from "../../src/application/schedule/scheduled-tasks.js";
import {
  createBriefProduction,
  createProjectionWorker,
  createScheduler,
  createStorage,
  type Storage,
} from "../../src/composition-root.js";

/**
 * "The scheduler is omitted when no tasks are wired for it to drive"
 * (Slice 12).
 *
 * A loop that wakes every minute to iterate an empty list is a timer with no
 * purpose, so the absence is expressed as `undefined` rather than as an idle
 * scheduler — which also means the caller cannot start one by accident.
 */

let storage: Storage;

beforeEach(() => {
  storage = createStorage();
});

afterEach(() => {
  storage.close();
});

describe("the scheduler is omitted when nothing is wired", () => {
  it("returns nothing when no work is given at all", () => {
    expect(createScheduler({})).toBeUndefined();
  });

  it("returns a scheduler once the projection worker is wired", () => {
    expect(createScheduler({ worker: createProjectionWorker(storage) })).toBeDefined();
  });

  it("returns a scheduler when only brief production is wired", () => {
    expect(createScheduler({ production: createBriefProduction(storage) })).toBeDefined();
  });
});

describe("the tasks a full wiring produces", () => {
  it("drives projection catch-up and both brief kinds", () => {
    const tasks = scheduledTasks({
      worker: createProjectionWorker(storage),
      production: createBriefProduction(storage),
    });

    expect(tasks.map((task) => task.name)).toEqual([
      "projection catch-up",
      "daily brief",
      "weekly brief",
    ]);
  });

  it("drives only the projection when no brief production is wired", () => {
    const tasks = scheduledTasks({ worker: createProjectionWorker(storage) });

    expect(tasks.map((task) => task.name)).toEqual(["projection catch-up"]);
  });
});
