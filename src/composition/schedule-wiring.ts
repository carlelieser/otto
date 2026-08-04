import { BriefProduction } from "../application/pipeline/produce-brief.js";
import { Scheduler } from "../application/schedule/scheduler.js";
import { scheduledTasks, type ScheduledWork } from "../application/schedule/scheduled-tasks.js";
import { InMemoryBriefGenerator } from "../infrastructure/llm/in-memory-brief-generator.js";
import type { BriefGenerator } from "../ports/brief-generator.js";
import type { BriefStore } from "../ports/brief-store.js";
import type { EventStore } from "../ports/event-store.js";

/**
 * Assembling the periodic side: brief production, and the loop that drives it.
 *
 * Inside `composition/`, which shares the root's exemption from ADR-0001's
 * import rule. It moved out of `composition-root.ts` for the reason
 * `projection-wiring.ts` and `extractor-selection.ts` did — the root outgrew a
 * readable length, and the honest split is by what the code assembles rather
 * than by moving a boundary. What runs on a request and what runs on a timer
 * change for different reasons.
 *
 * The dependencies are named as ports rather than as the `Storage` bundle, so
 * this module says what each function actually needs. A caller passing the
 * bundle still typechecks.
 */

/** What brief production reads from and writes to. */
export interface BriefWiring {
  readonly events: EventStore;
  readonly briefs: BriefStore;
}

/**
 * Brief production, wired to the log, the brief table, and a generator.
 *
 * The generator defaults to the in-memory one, which writes the selection down
 * rather than writing prose. That is the honest wiring today: Slice 10 built
 * the port and this adapter and left the model-backed adapter unbuilt, so a
 * default naming a provider would be a default that throws. A brief still gets
 * written, still records what mattered, and still reads plainly — which is the
 * degradation `compose-brief.ts` already designs for.
 */
export function createBriefProduction(
  storage: BriefWiring,
  generator: BriefGenerator = new InMemoryBriefGenerator(),
): BriefProduction {
  return new BriefProduction({ events: storage.events, briefs: storage.briefs, generator });
}

/**
 * The scheduler, or `undefined` when nothing is wired for it to drive.
 *
 * Returning `undefined` rather than an idle scheduler is Slice 12's "omitted
 * when no tasks are wired": a loop that wakes every minute to iterate an empty
 * list is a timer with no purpose, and the caller that would have to check for
 * one anyway is the caller that starts it.
 */
export function createScheduler(work: ScheduledWork, now: () => string): Scheduler | undefined {
  const tasks = scheduledTasks(work);
  return tasks.length === 0 ? undefined : new Scheduler({ tasks, now });
}
