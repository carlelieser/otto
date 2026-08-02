import { BRIEF_KINDS, type BriefKind } from "../../inference/salience/brief-selection.js";
import type { BriefStore } from "../../ports/brief-store.js";
import { briefIdFor } from "../pipeline/write-brief.js";
import type { BriefProduction } from "../pipeline/produce-brief.js";
import type { ProjectionWorker } from "../projection/projection-worker.js";
import { dueBriefWindows } from "./brief-windows.js";
import type { ScheduledTask } from "./scheduler.js";

/**
 * The two things the scheduler drives (Slice 12).
 *
 * Both already existed with no caller outside a test: Slice 6 built
 * `catchUp` for a caller to schedule, and Slice 10 built `produce` with
 * idempotency specified for a scheduler that fires twice. This is that caller,
 * and it is deliberately thin — the decisions about *what* is due live in
 * `brief-windows.ts`, and the decision about what to fold lives in the worker.
 */

/**
 * Projection catch-up, on every tick.
 *
 * It has no wall-clock trigger because it has no window: the read path lags the
 * log by however long the fold takes (`add.md` §6), and the job is to keep that
 * lag short rather than to do something at a particular hour. `catchUp` reads
 * its own starting position from the checkpoint, so a tick with nothing new
 * appended reads an empty batch and returns.
 */
export function projectionCatchUpTask(worker: ProjectionWorker): ScheduledTask {
  return {
    name: "projection catch-up",
    run: async () => {
      await worker.catchUp();
    },
  };
}

/**
 * Brief production for one kind, on its wall-clock trigger.
 *
 * One task per kind rather than one that does both, so that a daily brief a
 * provider failure cost does not also cost the weekly one — the isolation the
 * scheduler gives tasks is only worth having if the tasks are separated along
 * the lines that fail independently.
 *
 * Each due window is produced by an ordinary call with that window's instant.
 * `produce` is already idempotent on the brief id, so the dueness check ahead
 * of it is an optimisation — it saves reading the whole log for a window that
 * is already written — rather than the thing that makes repeated ticks safe.
 */
export function briefTask(
  kind: BriefKind,
  production: BriefProduction,
  briefs: BriefStore,
): ScheduledTask {
  return {
    name: `${kind} brief`,
    run: async (now) => {
      const windows = await dueBriefWindows(kind, now, (covers) => isStored(briefs, kind, covers));
      for (const covers of windows) {
        await production.produce(kind, covers);
      }
    },
  };
}

/** Whether the brief for the window covering this instant is already written. */
async function isStored(briefs: BriefStore, kind: BriefKind, covers: string): Promise<boolean> {
  return (await briefs.byId(briefIdFor(kind, covers))) !== undefined;
}

/**
 * Every scheduled task, in the order a tick runs them.
 *
 * Projection catch-up goes first: a brief reads the log directly rather than
 * the projection, so the order does not change what a brief says, but a tick
 * that produced briefs first would leave the read path stale for the duration
 * of a model call the user is about to read the result of.
 */
export function scheduledTasks(dependencies: ScheduledWork): readonly ScheduledTask[] {
  const { worker, production, briefs } = dependencies;
  return [
    ...(worker === undefined ? [] : [projectionCatchUpTask(worker)]),
    ...(production === undefined || briefs === undefined
      ? []
      : BRIEF_KINDS.map((kind) => briefTask(kind, production, briefs))),
  ];
}

/**
 * What the scheduler can be given, each half optional.
 *
 * Optional so that a host wiring only one of them gets only that one's tasks,
 * and so that "the scheduler is omitted when no tasks are wired" is a fact
 * about an empty list rather than a flag someone sets.
 */
export interface ScheduledWork {
  readonly worker?: ProjectionWorker;
  readonly production?: BriefProduction;
  readonly briefs?: BriefStore;
}
