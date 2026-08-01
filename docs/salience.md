# Otto — Salience and Briefs

> Status: v0 accepted for MVP, and expected to be replaced. Architecture in [`add.md`](./add.md) §8; product intent in [`prd.md`](./prd.md) §5.7.
>
> Earlier drafts of the PRD called this the largest undesigned area of the product, and they were right. This document does not claim to solve it. It specifies a deliberately crude v0 that ships, states what it is known to get wrong, and relies on ADD §8's architectural bet — salience is a projection, so the rules can be replaced and recomputed from history rather than migrated.

## 1. Why a crude answer beats no answer

Briefs are in MVP scope (PRD §7.1), so something has to select what goes in them. The choice is between a rule set designed now with no usage data, and one designed later with data — and the second is not available before shipping.

What makes shipping a crude version safe is that **salience is derived** (ADD §8). It is recomputed from the event log, so replacing the rules is a rebuild rather than a migration, and there is no accumulated state to be wrong. The cost of a bad v0 is a few weeks of mediocre briefs and no permanent damage. The cost of waiting is no briefs at all.

So v0 is written to be *legible* rather than clever: every score is a sum of named terms a human can read off, because the point of v0 is to generate the observations that produce v1.

## 2. The v0 score

Salience is computed per entity, on a 0–100 scale, as a sum of terms. No decay curve fitting, no learned weights, no embeddings.

```
salience = recency + open_loop + imminence + attention_debt − dormancy
```

**`recency`** — how recently the entity was mentioned in a Capture. Linear decay over 30 days, from 40 at today to 0 at 30 days. The single largest term, because the thing the user just wrote about is usually the thing on their mind.

**`open_loop`** — 25 for a Project with `status: active` or `blocked`, 25 for a Task with `status: open`, 0 otherwise. An entity with nothing outstanding is not competing for attention.

**`imminence`** — for anything carrying a date in the future: 30 within 2 days, 20 within a week, 10 within a month, 0 beyond. Applies to Event `occurred_at`, Task `due`, Project `due`. Past-dated open items keep 30 until closed, because a missed deadline is more salient than an upcoming one, not less.

**`attention_debt`** — 15 for a Project with `status: blocked` and no mention in 14 days, 15 for a Task open and unmentioned for 30 days. This is the term that surfaces the thing the user has quietly stopped thinking about, which is the one thing a system like this can do that the user cannot do for themselves.

**`dormancy`** — subtracts 20 from anything with `status` in `done`, `dropped`, `abandoned`, or an Event more than 7 days past with an `outcome` recorded. Closed things sink.

**Person salience is derived from association rather than scored directly.** A Person's score is the maximum salience of the Projects, Tasks, and Events they relate to, plus their own `recency` term. People are rarely salient on their own — they are salient because something involving them is.

## 3. What v0 is known to get wrong

**Everything decays at the same rate.** A quarterly planning Project and a lunch next Tuesday decay identically, which is wrong — different things have different natural rhythms. Fixing this properly needs per-entity or per-type decay rates, and there is no basis for choosing them yet.

**Recency dominates.** A note written today about something unimportant will outrank a genuinely important stalled Project. This is the most likely v0 complaint and the most likely first fix.

**Nothing models the user's own attention.** Salience measures the knowledge base, not what the user has already looked at. An entity the user opened this morning still scores as though they had not. Adjudications and entity views are recorded, so this is available to v1.

**No notion of periodicity.** A weekly one-on-one and a one-off meeting look the same.

**Relations barely contribute.** Only Person salience uses the graph. A Project connected to five active things and one connected to nothing score alike, which almost certainly understates the first.

## 4. Brief composition

ADD §8 fixed the architecture: selection precedes generation, and the generator sees structured knowledge rather than raw prose. This is the selection.

### Daily

Readable in under two minutes (PRD §5.7). Four sections, each capped, and **empty sections are omitted rather than padded** — a brief that manufactures content on a quiet day teaches the user to skim.

| Section | Selection | Cap |
|---|---|---|
| Today | Events with `occurred_at` today; Tasks with `due` today or overdue | 8 |
| Worth doing | Highest-salience open Tasks and Project `next_action` values not already listed | 5 |
| Looks stuck | Entities where `attention_debt` fired | 3 |
| Coming up | Events and due dates within 7 days, excluding today | 5 |

If everything is empty, the brief says so in one line. That is a legitimate output.

### Weekly

Broader, and about change rather than state — which is what the event log makes cheap and a pile of notes does not.

| Section | Selection | Cap |
|---|---|---|
| What moved | Entities with status changes or ≥3 change events this week | 8 |
| What didn't | `open_loop` entities with no events this week and none last week | 5 |
| Open loops | Highest-salience open Tasks and blocked Projects | 8 |
| New this week | Entities created this week | 10 |
| People | Persons mentioned this week, and Persons with no contact in 60 days who were previously frequent | 6 |

The last row is the one most likely to justify the whole feature, and also the most likely to be annoying. It is worth watching.

**Patterns noticed across the week** (PRD §5.7) are left to the generator: the selected structured data is passed to an LLM which may observe what it observes, with no requirement to produce something. A forced insight is worse than none.

### Generation

One LLM call per brief, given the selected entities as structured data with their fields, relations, and recent events, and asked for short prose. It cannot introduce entities that were not selected — same constraint as extraction (ADD §5.4), for the same reason.

Briefs are generated on a schedule, stored, and surfaced in the dashboard rather than pushed (PRD §5.7). A brief is not regenerated once written; it is a record of what mattered on that day, and rewriting history is not something Otto does anywhere else either.

## 5. How v0 gets replaced

The path from v0 to v1 is a measurement, not a redesign, and the instrumentation ships with v0.

**What is recorded**: which entities appeared in each brief, which of those the user then opened, and which high-salience entities the user opened without a brief having surfaced them. That is a precision and recall signal for the selection rules, gathered passively with no feedback UI.

**What v1 is allowed to do**: change weights, add terms, add per-type decay, use the graph. What it may not do is become unreadable — the property that makes v0 replaceable is that a human can read a score and say why it is wrong, and a learned model that loses that property costs more than it gains at this scale.

**A recomputation is a projection rebuild** (ADD §8). New rules apply to all history immediately, and comparing v0 and v1 rankings over the same log is possible because both are derivable from it. That is the payoff the architecture was buying.
