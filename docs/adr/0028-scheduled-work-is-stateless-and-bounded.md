# Scheduled work is stateless and bounded

---
Status: accepted
---

Slice 6 built `ProjectionWorker.catchUp()` for a caller to schedule. Slice 10 built `BriefProduction.produce(kind, now)` with idempotency specified for "a scheduler that fires twice". Neither had a caller outside a test. Slice 12 adds the caller, and in adding it has to answer what the scheduler knows and how far back it reaches.

**The scheduler stores nothing.** It is a timer and a list of named tasks. Whether the daily brief is due is answered by looking for a brief with today's id in the `briefs` table; whether the projection has work is answered by its checkpoint. There is no last-run timestamp, no schedule table, and nothing to migrate.

The alternative — a scheduler that records what it has run — is a second answer to a question that already has one. A brief *is* the record that the brief was produced, and `brief_id` is already derived from the kind and the date covered (ADR-0027), which already makes one-brief-per-day a primary key rather than a rule someone enforces. A separate last-run field would be a second source of truth that can disagree with the first, and the disagreement is silent in both directions: ahead of the briefs table it skips a morning, behind it re-fires and is saved only by the idempotency it was supposed to be replacing.

The property this buys is that a restart at any hour resumes correctly. Otto is a desktop application that is closed and opened constantly, and a scheduler whose correctness depended on having been running is a scheduler that is wrong most of the time.

**Catch-up is bounded to two days for daily briefs and one week for weekly.** PRD §4.7 requires that a week away creates no backlog to clear. Unbounded catch-up answers a month's absence with thirty model calls and thirty briefs about days the user has stopped caring about, which *is* the backlog rather than the absence of one.

The bound is a window of candidate days — today and the day before for daily, today and the six days before for weekly — each of which is a window only if its trigger has passed. For the weekly kind that means the window contains exactly one Monday on every day of the week, so a tick produces at most one weekly brief: the most recent Monday whose 06:00 has passed. A seven-day window is what makes that true. An eight-day one would contain two Mondays every Monday and produce two weekly briefs on the day the current week's is due, which is the "one brief per window" rule failing on the one day it matters most.

Older windows are skipped permanently, and nothing records that they were skipped. That is deliberate and follows from ADR-0027: the brief that would have been written is the only thing that would have recorded it, and a table of briefs-not-written would be state the scheduler keeps — which is the thing this ADR just refused. A user who was away for a month gets yesterday's and today's brief, which is what they would have read anyway.

Because `readSalientEntities` and `briefIdFor` both take the covered instant as a parameter, producing a missed window is an ordinary call with a past timestamp rather than a second code path. Each window is normalised to its own trigger hour rather than to the tick that noticed it, so a brief produced at Tuesday lunchtime for Monday scores Monday's log rather than Monday's log plus a day and a half.

**Brief dates are local, and this is the one place an instant crossing a boundary is not reduced to UTC.** `briefIdFor` derived its date from `toISOString`, which is correct at UTC and at negative offsets, and wrong at positive ones: a brief produced at 06:00 in Tokyo is still the previous day in UTC, so the id named the day before the one the brief covered — and then collided with the next morning's brief, because the id is also the idempotency key. Both the trigger hour and the covered date are therefore read through `local-time.ts`, which asks the zone rather than shifting by a fixed offset, because a fixed offset is wrong twice a year.

The zone is the host's and is not configurable. Otto is local-first and single-user (PRD §4.6), so the machine's zone is the user's zone, and a setting would be a second answer to a question the operating system already answers.

**A failing task costs the tick it failed in and nothing else.** Tasks run sequentially, each wrapped so that a throw is reported to stderr and the loop continues. `qa.md` §9 requires that an unavailable LLM costs timeliness rather than data, and statelessness is what makes that hold across ticks as well as within one: a brief that could not be generated this minute leaves its window due, because nothing was stored for it, so the next tick tries again with no retry bookkeeping at all.

Sequential rather than concurrent because the tasks share one SQLite connection with a single writer (`runtime.md` §1), and because brief production reads the whole log — not work to run alongside a projection fold.

## Considered Options

- **A last-run timestamp, or a `scheduled_runs` table** — rejected above: a second source of truth for a question the `briefs` table already answers, whose disagreements are silent.
- **Unbounded catch-up** — rejected: it converts an absence into the backlog PRD §4.7 says must not exist, and spends a model call per missed day on days the user has moved past.
- **Record skipped windows so the user can request them** — rejected: it reintroduces scheduler state to support a request nothing in MVP can make, and ADR-0027 already establishes that a brief regenerated later under different coefficients is a different brief rather than the missed one.
- **Wake timers or a background daemon so briefs are produced while Otto is closed** — rejected for MVP: `runtime.md` §1 supervises a sidecar process rather than a daemon, and the bounded catch-up makes launch-time production sufficient. PRD §5.7 excludes push notifications, so a brief produced at 06:00 with the application closed would be read at launch regardless.
- **Configurable trigger hour and weekly day** — rejected: PRD §7.2 places brief customisation post-MVP. Whether 06:00 is right is a product question `salience.md` §5's instrumentation answers by measuring whether briefs get read, not one a setting resolves.
- **Reduce brief dates to UTC like every other instant** — rejected: it names the wrong day at positive offsets and collides consecutive briefs. A brief is about the user's calendar day, which is the one thing here that is genuinely local.

## Consequences

- Otto performs no work while it is closed. Briefs for a closed weekend appear within a tick of the next launch, dated to the days they cover.
- A user in a zone whose offset changes gets one brief whose window is 23 or 25 hours long. The date is still unambiguous, since the id comes from the local calendar date.
- The tick interval sets only the resolution at which dueness is checked, so a brief can appear up to one interval after its trigger hour.
- Nothing measures whether a task is failing repeatedly. Each failure is a stderr line; a task that fails every tick produces one line per tick and no escalation. That is acceptable while the only tasks are idempotent and cheap to retry, and is the first thing to revisit if a third task is added.
- The scheduler is `undefined` rather than idle when no tasks are wired, so a host that wires neither half starts no timer.
