import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BriefProduction } from "../../src/application/pipeline/produce-brief.js";
import { BriefReads } from "../../src/application/surface/read-briefs.js";
import { Scheduler } from "../../src/application/schedule/scheduler.js";
import { scheduledTasks } from "../../src/application/schedule/scheduled-tasks.js";
import { localDateOf } from "../../src/application/schedule/local-time.js";
import {
  createExecutor,
  createProjectionWorker,
  createStorage,
  type Storage,
} from "../../src/composition-root.js";
import { InMemoryBriefGenerator } from "../../src/infrastructure/llm/in-memory-brief-generator.js";
import type { BriefGenerator } from "../../src/ports/brief-generator.js";
import { CREATE_ENTITY, SET_FIELD } from "../../src/domain/commands/knowledge-commands.js";
import type { Command } from "../../src/domain/commands/command.js";
import { aProvenance } from "../support/builders.js";

/**
 * The slice's "Done when", against real storage: the sidecar produces a brief
 * and advances the projection with no request having arrived (Slice 12).
 *
 * This is the seam the unit tests above it cannot cover — that the tasks, the
 * dueness checks, and the stores agree about what has already been done. Ticks
 * are driven directly; the interval is `scheduler.test.ts`'s subject.
 */

const original = process.env.TZ;

/** 09:00 on Sunday 2026-08-02, past the trigger hour with the day's brief unwritten. */
const SUNDAY_MORNING = "2026-08-02T09:00:00.000Z";

/** 09:00 on Monday 2026-08-03, when the weekly brief is also due. */
const MONDAY_MORNING = "2026-08-03T09:00:00.000Z";

let storage: Storage;
let reads: BriefReads;

beforeEach(async () => {
  process.env.TZ = "UTC";
  storage = createStorage();
  reads = new BriefReads(storage.briefs);
  await givenAnOpenTask();
});

afterEach(() => {
  storage.close();
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

/** A scheduler over real storage, with an optionally substituted generator. */
function schedulerAt(now: string, generator: BriefGenerator = new InMemoryBriefGenerator()) {
  const production = new BriefProduction({
    events: storage.events,
    briefs: storage.briefs,
    generator,
  });
  const tasks = scheduledTasks({
    worker: createProjectionWorker(storage),
    production,
    briefs: storage.briefs,
  });
  return new Scheduler({ tasks, now: () => now, report: () => {} });
}

describe("a tick with no request dispatched", () => {
  it("produces the daily brief", async () => {
    await schedulerAt(SUNDAY_MORNING).tick();

    const [brief] = await reads.recent("daily");
    expect(brief?.prose).toContain("Draft the report");
  });

  it("advances the projection", async () => {
    await schedulerAt(SUNDAY_MORNING).tick();

    expect((await storage.projections.checkpoint()).position).toBeGreaterThan(0);
  });

  it("produces the weekly brief on its day", async () => {
    await schedulerAt(MONDAY_MORNING).tick();

    expect(await reads.recent("weekly")).toHaveLength(1);
  });

  /**
   * A Sunday tick still owes the *previous* Monday's weekly brief, within the
   * one-week bound — so what "not its day" means is that no brief is written
   * for Sunday, not that nothing weekly happens.
   */
  it("writes no weekly brief dated to a day that is not its day", async () => {
    await schedulerAt(SUNDAY_MORNING).tick();

    const ids = (await reads.recent("weekly")).map((brief) => brief.briefId);
    expect(ids).not.toContain("weekly-2026-08-02");
    expect(ids).toEqual(["weekly-2026-07-27"]);
  });
});

/**
 * "Ten ticks within one window produce one brief and one generator call."
 *
 * One brief *per window*: the first tick also catches up the day before, which
 * is the bound working rather than a repeat. What the ten ticks must establish
 * is that nothing after the first one writes or generates anything.
 */
describe("repeated ticks within one window", () => {
  it("produce one brief per window and one generator call each", async () => {
    let calls = 0;
    const counting: BriefGenerator = {
      async generate() {
        calls += 1;
        return { prose: "Draft the report", provider: "test", modelVersion: "v0" };
      },
    };
    const scheduler = schedulerAt(SUNDAY_MORNING, counting);

    await scheduler.tick();
    const afterFirst = (await reads.recent("daily")).length;
    const callsAfterFirst = calls;
    for (let tick = 0; tick < 9; tick += 1) await scheduler.tick();

    expect(await reads.recent("daily")).toHaveLength(afterFirst);
    expect(calls).toBe(callsAfterFirst);
  });

  it("write one brief for the current day however many times they run", async () => {
    const scheduler = schedulerAt(SUNDAY_MORNING);

    for (let tick = 0; tick < 10; tick += 1) await scheduler.tick();

    const today = (await reads.recent("daily")).filter(
      (brief) => brief.briefId === "daily-2026-08-02",
    );
    expect(today).toHaveLength(1);
  });
});

/** "An application closed for a weekend produces the bounded set of missed briefs." */
describe("catch-up on next launch", () => {
  it("produces two briefs after a two-day gap, each carrying its own date", async () => {
    await schedulerAt(SUNDAY_MORNING).tick();

    const dates = (await reads.recent("daily")).map((brief) => brief.briefId);
    expect(dates).toHaveLength(2);
    expect(dates).toContain("daily-2026-08-02");
    expect(dates).toContain("daily-2026-08-01");
  });

  it("produces the same bounded set after a month closed", async () => {
    await schedulerAt("2026-09-02T09:00:00.000Z").tick();

    expect(await reads.recent("daily")).toHaveLength(2);
  });

  it("covers each brief's own window rather than the tick's instant", async () => {
    await schedulerAt(SUNDAY_MORNING).tick();

    for (const brief of await reads.recent("daily")) {
      expect(brief.briefId).toBe(`daily-${localDateOf(brief.selection.coversTo)}`);
    }
  });
});

/**
 * "A failing task does not halt the loop": with a generator that throws,
 * projection catch-up still runs and the next window's brief is produced.
 */
describe("a failing generator", () => {
  it("does not stop the projection advancing", async () => {
    await schedulerAt(SUNDAY_MORNING, throwingGenerator()).tick();

    expect((await storage.projections.checkpoint()).position).toBeGreaterThan(0);
  });

  it("leaves the window due, so a later tick produces the brief", async () => {
    await schedulerAt(SUNDAY_MORNING, throwingGenerator()).tick();
    expect(await reads.recent("daily")).toHaveLength(0);

    await schedulerAt(SUNDAY_MORNING).tick();

    expect((await reads.recent("daily")).length).toBeGreaterThan(0);
  });
});

function throwingGenerator(): BriefGenerator {
  return {
    async generate() {
      throw new Error("provider unavailable");
    },
  };
}

/** One open Task in the log, which is enough for a brief to have something to say. */
async function givenAnOpenTask(): Promise<void> {
  const executor = createExecutor(storage.events, () => "2026-08-01T12:00:00.000Z");
  await executor.execute(createTask());
  await executor.execute(setStatus());
}

function createTask(): Command {
  return {
    type: CREATE_ENTITY,
    aggregate: { type: "Entity", id: "t1", expectedVersion: 0 },
    payload: { entityType: "Task", name: "Draft the report" },
    provenance: aProvenance(),
  };
}

function setStatus(): Command {
  return {
    type: SET_FIELD,
    aggregate: { type: "Entity", id: "t1", expectedVersion: 1 },
    payload: { field: "status", value: "open" },
    provenance: aProvenance(),
  };
}
