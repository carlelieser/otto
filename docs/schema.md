# Otto — Knowledge Schema

> Status: accepted for MVP. Vocabulary lives in [`CONTEXT.md`](../CONTEXT.md); architecture in [`add.md`](./add.md); settled decisions in [`docs/adr/`](./adr/).
>
> This document is the field-level model that ADR-0010 made load-bearing. It is not the SQL schema — it is the list of things Otto is allowed to know, which the extractor's output schema, the differ's cardinality rules, and the entity views all derive from. The SQL follows from this; where they disagree, this document is wrong and should be corrected rather than worked around.

## 1. How to read this

Every field carries four properties, and the differ needs all four.

**Type.** What the value is. Kept deliberately narrow — `text`, `date`, `enum`, `ref`, and sets of those. There is no nested-object field anywhere in the model; a thing with structure is an entity or a Relation, not a field.

**Cardinality.** `single` or `set`. This is the property ADR-0010 moved out of a predicate vocabulary and into the schema, and it is what tells the differ whether a new value supersedes the old one or joins it. A `single` field with a new value produces a supersession; a `set` field unions and never silently drops a member.

**Extractable.** Whether Extraction is permitted to propose a value for this field. Fields marked `derived` are computed by projection and can never appear in a Proposal — if the extractor emits one, it is dropped and the drop is logged as a schema violation, not accepted quietly.

**Disposition floor.** The lowest-friction Disposition a change to this field may receive, before Confidence is considered. Most fields are `auto` — meaning triage may auto-apply them if Confidence clears the bar. A few carry `review`, meaning a change to that field always waits for a human regardless of how confident Otto is, because getting it wrong is expensive in a way that a wrong `notes` line is not. This is the field-level extension of ADR-0007's application policy and lives with it in `domain/policies/`.

Two conventions apply to every entity and are not repeated in the tables:

- **Identity fields** — `id`, `created_at`, `updated_at` — exist on all five and are never extractable.
- **Provenance pointers** — per ADD §7, every field carries a pointer to the event that last set it. This is structural and not itself a field.

## 2. Shared fields

These five fields mean the same thing on every entity type, and are defined once here rather than repeated with drift.

| Field | Type | Cardinality | Extractable | Floor | Notes |
|---|---|---|---|---|---|
| `name` | text | single | yes | `review` | The entity's current display name. Renaming is identity-adjacent, which is why it never auto-applies — see §6. |
| `aliases` | text | set | yes | `auto` | Other names the entity has been referred to by. Feeds candidate generation directly. Never shrinks except by explicit user action. |
| `summary` | text | single | yes | `auto` | One or two sentences of what this is. Regenerated as understanding changes; the most frequently superseded field in the model. |
| `notes` | text | set | yes | `auto` | Standalone facts that do not fit a typed field. The escape hatch — see §7. |
| `salience` | number | single | derived | — | Computed by projection (ADD §8). Never proposed, never written by a Command. |

## 3. Person

Someone in the user's life, with an identity that persists through renaming.

| Field | Type | Cardinality | Extractable | Floor | Notes |
|---|---|---|---|---|---|
| `employer` | text | single | yes | `auto` | Where they work. Superseded on change — the job history lives in the event log, not in a set. |
| `role` | text | single | yes | `auto` | What they do, at `employer` or generally. |
| `location` | text | single | yes | `auto` | Free text, deliberately not structured. "Lisbon" and "the Berlin office" are both acceptable values. |
| `relationship` | enum | single | yes | `auto` | How they relate to the user: `colleague`, `friend`, `family`, `client`, `acquaintance`, `other`. Closed set; §7 covers what happens when nothing fits. |
| `contact` | text | set | yes | `auto` | Email addresses, handles, phone numbers. A set because people have several and rarely lose them. |
| `last_contact_at` | date | single | derived | — | The most recent Capture mentioning this Person in a way Extraction marked as contact rather than reference. PRD §5.3 requires it on the Person view. |

## 4. Project

An ongoing effort the user is involved in, which may outlive the people associated with it.

| Field | Type | Cardinality | Extractable | Floor | Notes |
|---|---|---|---|---|---|
| `status` | enum | single | yes | `auto` | `active`, `blocked`, `paused`, `done`, `abandoned`. The one field the daily brief leans on hardest. |
| `blocker` | text | single | yes | `auto` | Why it is blocked, when it is. Cleared by a status change away from `blocked` — the differ handles this as a dependent field, §6. |
| `next_action` | text | single | yes | `auto` | The next concrete thing to do. Distinct from a Task: this is a description carried on the Project, not a tracked entity. When Extraction produces something task-shaped and assignable, it becomes a Task with a `concerns` Relation instead. |
| `outcome` | text | single | yes | `auto` | What finishing looks like. Set early, rarely changed. |
| `due` | date | single | yes | `auto` | A deadline if one was stated. Absent far more often than present. |
| `started_at` | date | single | yes | `auto` | When work began, if the note says. |

## 5. Idea, Event, Task

**Idea** — a thought worth keeping that is not yet a Project or a Task.

| Field | Type | Cardinality | Extractable | Floor | Notes |
|---|---|---|---|---|---|
| `body` | text | single | yes | `auto` | The idea itself, in more detail than `summary`. The one field that carries real prose. |
| `status` | enum | single | yes | `auto` | `open`, `promoted`, `dropped`. `promoted` means it became a Project or Task, recorded by a `became` Relation. |

**Event** — something that happened or will happen at a point in time.

| Field | Type | Cardinality | Extractable | Floor | Notes |
|---|---|---|---|---|---|
| `occurred_at` | date | single | yes | `auto` | When it happened or will happen. Resolved against the Capture timestamp — see §8. |
| `ends_at` | date | single | yes | `auto` | For events with duration. Usually absent. |
| `location` | text | single | yes | `auto` | Free text, as with Person. |
| `kind` | enum | single | yes | `auto` | `meeting`, `call`, `deadline`, `milestone`, `social`, `other`. |
| `outcome` | text | single | yes | `auto` | What came of it. Only meaningful for past events, and typically arrives in a later Capture than the one that created the Event. |

**Task** — something the user intends to do.

| Field | Type | Cardinality | Extractable | Floor | Notes |
|---|---|---|---|---|---|
| `status` | enum | single | yes | `auto` | `open`, `done`, `dropped`. No `in_progress` — PRD §6 is explicit that Otto is not a task manager, and the state that would justify it is project-level. |
| `due` | date | single | yes | `auto` | If stated. |
| `done_at` | date | single | yes | `auto` | When it was completed, if the note says so. |

## 6. Relations

A Relation is a named, directed, revisable link between two entities (`CONTEXT.md`). The vocabulary is **closed**, for the reason given below.

ADR-0010 closed the predicate-vocabulary question for *fields*, but Relations reopen exactly the same problem at the edge level: an open set means Extraction invents relation names and the graph fragments into `works_on`, `working_on`, and `involved_with` meaning one thing. So the set is fixed, small, and typed by the pair of entity types it connects. Adding a relation name is a schema change — the same honest cost ADR-0010 accepted for fields.

| Relation | From → To | Cardinality | Notes |
|---|---|---|---|
| `involves` | Project → Person | set | Who is working on it. The most common relation in the graph by a wide margin. |
| `concerns` | Task → Person, Project, Idea, Event | set | What the Task is about. A Task may concern several things. |
| `attended` | Event → Person | set | Who was there, or is expected to be. |
| `relates_to` | Project → Project, Idea → Idea, Idea → Project | set | Untyped association, symmetric in meaning though stored directed. The deliberate catch-all, and the one to watch: if it dominates the graph, the vocabulary is too small and needs a named addition. |
| `became` | Idea → Project, Idea → Task | single | Records promotion. Paired with `status: promoted` on the Idea. |
| `blocks` | Task → Task, Project → Project, Task → Project | set | Dependency. Directed and meaningful. |
| `knows` | Person → Person | set | Two people in the user's life who know each other. Only recorded when a note says so — never inferred from co-occurrence, which would fill the graph with noise. |

Relations carry their own Provenance and their own Disposition floor of `auto`, with one exception: **`became` has a floor of `review`**, because it is a supersession of one entity by another and sits closer to merge than to an ordinary edge.

**Removing a relation is a `remove` Command** and therefore never auto-applies (ADR-0007). "Sarah is no longer on the website project" waits for the user.

## 7. Two rules that keep the schema honest

**Closed enums with an `other` member.** Every enum above is closed, and each has an escape value. When Extraction wants a value outside the set, it emits `other` and puts the specific value in `notes`. This keeps the differ's typing intact while making the pressure visible: a run of `other` values in `relationship` is the signal that the enum needs a new member, and it arrives as data rather than as a bug report.

**`notes` is the pressure valve, and it is monitored.** Anything true about an entity that no typed field can hold becomes a `notes` entry. This is what stops the absence of a field from meaning the loss of a fact — a schema that cannot express "Sarah is allergic to shellfish" should still not throw the sentence away. The cost is that `notes` is unqueryable structure, so its growth rate is the schema's own health metric: a field that keeps being reinvented in `notes` is a field the schema is missing.

Neither rule permits Extraction to invent a field name. The extractor's output schema is generated from these tables, so an unknown field is rejected at parse time (ADD §5.2) rather than reaching the differ.

## 8. Dates and relative time

Notes say "Tuesday," not `2026-08-04`. Resolving that is **Extraction's job**, not Ingestion's — ADD §5.1 uses date-noticing as its example of what Ingestion must not do, and that rule stands.

The mechanism: the Capture's timestamp is provided to the extractor as context, and the extractor returns dates already absolute. It also returns a `date_precision` marker alongside each — `exact`, `day`, `month`, `quarter`, `year`, or `relative_unresolved` — because "sometime next quarter" and "on the 4th" should not become indistinguishable timestamps. Precision is stored with the date and is what the UI renders from; a `quarter`-precision date displays as "Q3" and never as a specific day.

`relative_unresolved` is the honest failure case: "when the contract lands" is a real thing a note says and is not a date. It stores no timestamp, keeps the phrase, and is excluded from anything time-ordered.

## 9. What this schema deliberately cannot express

These are decisions, not oversights.

- **Contradiction.** Two live values for one `single` field. ADR-0010 chose supersession; the hybrid escape hatch it names is where to go if this ever becomes necessary.
- **Bitemporality.** Fields have no independent valid-time. "Sarah worked at Acme until March" is `employer: Globex` now, with Acme recoverable from the log, not a closed interval on live data (ADR-0010).
- **Confidence on knowledge.** No field holds a Confidence. It lives on the Proposal and the event, never on the entity (ADR-0002).
- **User-defined fields.** Adding a field is a code change. PRD §6 rules out user-maintained taxonomy, and a user-extensible schema is that by another name.
- **Attachments and rich content.** Captures hold text (PRD §6). No field references a file.
