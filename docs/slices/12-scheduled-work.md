# Slice 12 — Scheduled work

> Depends on: Slices 6 and 10. Blocks: Slice 11.
> Sources: [`prd.md`](../prd.md) §4.7, §5.7; [`add.md`](../add.md) §4, §6; [`runtime.md`](../runtime.md) §1; [`salience.md`](../salience.md) §4; [`qa.md`](../qa.md) §9.

## What it closes

Otto performs periodic work without a request arriving to trigger it: the daily brief each morning, the weekly brief on its day, and projection catch-up while the application runs.

## Why here

Slice 6 built `ProjectionWorker.catchUp()` for a caller to schedule. Slice 10 built `BriefProduction.produce(kind, now)` with idempotency specified for a scheduler that fires twice. Neither has a caller outside tests.

It follows Slice 10, which builds brief production. It precedes Slice 11, which renders briefs but does not produce them.

## In scope

**A scheduler in the sidecar**, driving `ProjectionWorker.catchUp` and `BriefProduction.produce`. Both are already constructed in `main.ts`.

**Wall-clock triggers.** The daily brief is due on the first tick after 06:00 local time with no brief stored for the current date. The weekly brief is due on the first tick after 06:00 local on Monday with none stored for the current week. Projection catch-up runs on a fixed interval.

**Local dates in brief ids.** `briefIdFor` derives its date from a UTC timestamp (`write-brief.ts`). At positive UTC offsets a brief generated at 06:00 local carries an id naming the adjacent day. The derivation takes the local date instead.

**Bounded catch-up for missed windows.** PRD §4.7 requires that a week away creates no backlog to clear; `qa.md` §9 tests that accumulated work drains without user action.

Briefs missed while the application was closed are generated for the windows they cover, bounded to **two days for daily briefs and one week for weekly**. Older windows are skipped permanently. `readSalientEntities` and `briefIdFor` both take the covered instant as a parameter, so a past window is produced by a call with a past timestamp.

**Per-task failure isolation.** A task that throws does not prevent other tasks in the same tick, or itself in the next window. `qa.md` §9 requires that an unavailable LLM costs timeliness rather than data.

**No scheduler state.** Dueness is read from the `briefs` table and the projection checkpoint. The scheduler stores nothing of its own.

**No output when idle.** A tick with no due work logs nothing.

## Not in scope

- **Brief methods on the transport, and any brief UI.** Slice 11. `BriefReads.unreadCount()` remains uncalled after this slice.
- **Configurable schedule times.** The trigger hour and the weekly day are constants. PRD §7.2 places brief customisation post-MVP.
- **Execution while Otto is closed.** No daemon and no wake timers; the scheduler runs while the application runs.
- **Push notifications.** Excluded by PRD §5.7. The tray badge is the only signal.
- **Snapshot cadence.** `runtime.md` §4.1 sets it to never. `catchUp` already carries the snapshot check.
- **Retry and backoff within a tick.** A failed task is attempted again on the next tick.

## Build order

1. The scheduler: injected clock, due checks, and the tick loop.
2. Projection catch-up on a fixed interval.
3. Daily brief production on the wall-clock trigger, with local-date id derivation.
4. Weekly brief production.
5. Bounded catch-up for missed windows.
6. Per-task failure isolation.
7. Wiring into `startCaptureSidecar`, omitted when no tasks are wired.

Every due check takes the current instant as a parameter, matching the `now` parameter `produce` takes.

## Verification

Tier 2 (`qa.md` §7).

- **Dueness, per case.** Before the trigger hour: not due. After it with a brief stored for the date: not due. After it with none: due.
- **Repeated ticks.** Ten ticks within one window produce one brief and one generator call.
- **Catch-up bounds.** A two-day gap produces two briefs, each carrying its own date. A thirty-day gap produces the bounded count.
- **A failing task does not halt the loop.** With a generator that throws, projection catch-up still runs and the next window's brief is produced.
- **Local-date ids.** A brief generated at 06:00 local at a UTC offset placing that instant on the adjacent UTC day carries the local date. The test sets the timezone explicitly.
- **Projection advance.** A tick advances the projection with no request dispatched.

Whether 06:00 and the two-day bound are correct is not tested. `salience.md` §5's instrumentation measures whether briefs are read.

## Done when

- The sidecar produces a daily brief and advances the projection with no request having arrived.
- Repeated ticks produce one brief per window and one generator call.
- An application closed for a weekend produces the bounded set of missed briefs on next launch, each carrying the date it covers; a month closed produces the same bounded set.
- A brief id names the local date it covers at any UTC offset.
- A failed task leaves the schedule running.
- The scheduler is omitted when no tasks are wired for it to drive.
