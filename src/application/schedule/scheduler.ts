/**
 * The tick loop: periodic work with no request to trigger it (Slice 12).
 *
 * Otto's other stages all begin with something arriving — a Capture, a
 * correction, a review decision. The daily brief and projection catch-up begin
 * with nothing arriving, and this is the only thing in the system that runs for
 * that reason.
 *
 * **It holds no state about what it has done.** A task decides its own dueness
 * from what is stored (`brief-windows.ts`), so the scheduler is a timer and a
 * list, and a restart at any hour resumes correctly rather than re-firing the
 * morning's work or going quiet until tomorrow. The alternative — a last-run
 * timestamp the scheduler keeps — is a second answer to "has today's brief been
 * written", and the first answer is the brief itself.
 *
 * **The loop runs while the application runs.** No daemon and no wake timers:
 * work missed while Otto was closed is caught up on the next launch, bounded,
 * rather than performed while it is closed.
 */

/** One thing the scheduler drives, named so a failure can say what failed. */
export interface ScheduledTask {
  /** What this task is called in a failure report. */
  readonly name: string;
  /**
   * Does whatever is due at `now`, or nothing.
   *
   * The instant is passed in rather than read, so a task is testable at any
   * hour of any day and the scheduler owns the one clock.
   */
  run(now: string): Promise<void>;
}

export interface SchedulerDependencies {
  readonly tasks: readonly ScheduledTask[];
  /** The clock, injected so a test can place a tick at any instant. */
  readonly now: () => string;
  /** How often the loop ticks. */
  readonly intervalMs?: number;
  /**
   * Where a task's failure is reported, defaulting to stderr.
   *
   * Stderr rather than stdout because the sidecar's stdout is the JSON-RPC
   * channel, and a diagnostic written there arrives at the host as a malformed
   * message (`main.ts`).
   */
  readonly report?: (message: string) => void;
}

/**
 * How often the loop ticks.
 *
 * Frequent enough that projection catch-up keeps the read path close to the
 * log, and coarse enough that a brief's trigger hour is not something the user
 * waits on. Dueness is a wall-clock question, so this only sets the resolution
 * at which the answer is checked.
 */
export const DEFAULT_TICK_MS = 60_000;

export class Scheduler {
  readonly #dependencies: SchedulerDependencies;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(dependencies: SchedulerDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Runs every task once, isolating each from the others' failures.
   *
   * Sequential rather than concurrent: the tasks share one SQLite connection
   * with a single writer (`runtime.md` §1), and brief production reads the
   * whole log, which is not work to run alongside a projection fold.
   */
  async tick(): Promise<void> {
    const now = this.#dependencies.now();
    for (const task of this.#dependencies.tasks) {
      await this.#runIsolated(task, now);
    }
  }

  /**
   * One task's turn, with its failure contained.
   *
   * A throwing task must not take the tick down with it: `qa.md` §9 requires
   * that an unavailable LLM costs timeliness rather than data, and a brief that
   * cannot be generated this minute is a brief generated next minute — the
   * window stays due because nothing was stored for it.
   */
  async #runIsolated(task: ScheduledTask, now: string): Promise<void> {
    try {
      await task.run(now);
    } catch (failure) {
      this.#report(`scheduled task ${task.name} failed: ${messageOf(failure)}`);
    }
  }

  /** Starts the loop, or does nothing when it is already running. */
  start(): void {
    if (this.#timer !== undefined) return;
    const { intervalMs = DEFAULT_TICK_MS } = this.#dependencies;
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref?.();
  }

  /** Stops the loop. Safe to call when it is not running. */
  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #report(message: string): void {
    const { report = defaultReport } = this.#dependencies;
    report(message);
  }
}

function defaultReport(message: string): void {
  process.stderr.write(`${message}\n`);
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
