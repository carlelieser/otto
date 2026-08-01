# Otto — Product Requirements

> Status: accepted for MVP. Vocabulary lives in [`CONTEXT.md`](../CONTEXT.md); settled architecture in [`docs/adr/`](./adr/) and [`add.md`](./add.md). Supporting specifications: [`schema.md`](./schema.md) (what Otto may know), [`triage.md`](./triage.md) (thresholds and dispositions), [`salience.md`](./salience.md) (what gets surfaced), [`runtime.md`](./runtime.md) (hosting and local models).

## 1. What Otto is

Otto is a private, local, cross-platform desktop application that maintains a knowledge base about the user's life — the people, projects, ideas, events, and tasks in it — from notes the user writes, without asking the user to organise anything.

The user's only job is to capture. Otto does the filing, keeps the structure current as understanding changes, and surfaces what deserves attention.

## 2. The problem

Every note system fails the same way. It asks for organisational work at capture time — which folder, which tag, which title — at exactly the moment the user has the least appetite for it. So notes get dumped somewhere unstructured, the structure never gets maintained, the user stops trusting it, and the system dies.

The systems that survive this are maintained by people organised enough not to need them.

Otto's premise is that the maintenance is now automatable. The user writes prose; Otto keeps the database.

## 3. Who it's for

One person: the user Otto belongs to. Otto is single-user by construction — not a product with an audience, an instrument with an owner. There is no sharing, no collaboration, no multi-tenancy, and no account.

## 4. Principles

These constrain every requirement below.

1. **Capture costs nothing.** One place, no decisions, no taxonomy. If capture takes more than a few seconds the user won't do it consistently, and everything downstream is worthless.
2. **The knowledge base maintains itself.** Otto updates what it knows as new notes arrive. The user never files, tags, or reconciles.
3. **Trust is a feature, not a side effect.** The user can always see what Otto did and why, and correcting it is one step. Errors that feel mysterious kill adoption faster than errors that are visible.
4. **Uncertain means ask, never guess.** Below the confidence bar, Otto holds and asks rather than writing something wrong into the knowledge base.
5. **Destructive changes always ask.** Removals, merges, and splits never happen unattended at any confidence (ADR-0007).
6. **Local and private.** Otto's data lives on the user's machine. Cloud inference is a choice, not a requirement — Otto must degrade to fully local models (ADR-0008).
7. **Restartable.** A week away creates no backlog to clear. Otto keeps working; the user resumes without penalty.

## 5. What the user does

### 5.1 Capture

Otto lives in the system tray. The user opens it, speaks or types a thought, and it's gone from their head.

- **Voice is the primary path.** Press, speak, release. Otto transcribes and stores the note.
- **Typed notes** are equally supported for when speaking isn't possible.
- **One note per thought.** No title, no category, no tags. Otto assigns none of that to the user.
- Capture is available from the tray without opening the full window.

The note itself is kept, immutably, forever (a **Capture** — see `CONTEXT.md`). Everything Otto derives points back to it.

### 5.2 The knowledge base

Otto maintains five kinds of entity, defined in `CONTEXT.md`: **Person**, **Project**, **Idea**, **Event**, and **Task**, plus the relations between them.

From each note Otto extracts what it's about, decides which existing entities are being referred to, and updates the knowledge base accordingly — creating entities that don't exist yet, updating ones that do.

The user browses this through a dashboard: a sidebar for navigating between notes and each entity type, and a main area listing them with search, sorting, and filtering.

### 5.3 The entity view

Opening a single entity is where the knowledge base pays off. A Person shows what Otto knows about them, the projects they're involved in, the events they were at, open follow-ups, and when the user last had contact. A Project shows its status, its next action, who's involved, and its history.

This is the difference between a pile of notes and a knowledge base: the user asks about one thing and gets everything connected to it, assembled from notes written weeks apart that never mentioned each other.

Every fact shown can be traced back to the note it came from.

### 5.4 The review queue

Otto shows the user what it decided. "Sarah added to People." "Website relaunch moved to blocked." Each entry states what changed and lets the user confirm it or correct it.

Four things arrive here:

- **Proposals Otto wasn't confident enough to apply unattended**, which wait for a decision before anything changes.
- **Destructive proposals** — removals and merges — which wait regardless of confidence. Splits too, when they arrive (§7.2).
- **Suspected duplicates** — two entities that look like one thing — offered as a merge the user confirms or dismisses (§5.7).
- **A sampled slice of confident changes** that Otto could have applied unattended and deliberately did not, so it can measure how often it is right when it thinks it is certain (`triage.md` §6). These are indistinguishable from ordinary entries and are not marked as tests.

Confident, non-destructive changes apply automatically and appear in the queue as a record rather than a request. The user can still correct them.

**Proposals below the low bar are recorded but not acted on**, and appear in a collapsed section the user never has to open. Otto does not drop things silently; "why didn't it pick that up?" has an answer.

Correcting is one action from the queue and does not require navigating to the entity.

**Otto asks more in its first weeks.** Until it has enough corrections to know what its own confidence is worth, it holds back from applying anything that required judgement about which entity was meant (`triage.md` §4). The dashboard says so plainly, because friction without explanation reads as the product being bad at its job.

### 5.5 Corrections

When the user corrects Otto, Otto records what the user chose instead — not merely that it was wrong (ADR-0006). "That's a different Sarah" attaches the right Sarah, and Otto keeps that as the corrected answer for the proposal that got it wrong.

Corrections are revisions of belief, not repairs of an error. Nothing is deleted; the change is recorded and history stays intact.

**Transcripts are correctable.** Voice capture mishears names, and a mishearing becomes a wrong entity. The user can fix the text of a voice note in one step; Otto re-reads it and updates what it derived. The original transcript is kept — nothing is overwritten (`runtime.md` §5). Typed notes are not editable: they were not misheard, and editing them would make Otto a document editor (§6).

### 5.6 Duplicates

Otto would rather create a second Sarah than attach a fact to the wrong one — a duplicate is visible and fixable, a misattribution quietly corrupts what the user knows (ADR-0009). That choice makes duplicates the expected outcome rather than a defect, so Otto has to be able to undo them.

Two things handle this. When Otto considers creating an entity that resembles one it already has, it asks rather than deciding (`triage.md` §3). And when duplicates exist anyway, Otto notices and offers to combine them from the review queue — the user confirms, and the two become one, with nothing lost from either.

Splitting one entity that turns out to be two is deferred (§7.2); it needs an interface that combining does not.

### 5.7 Briefs

Otto surfaces what deserves attention on a cadence, in the dashboard.

**Daily.** Short, readable in a couple of minutes. What matters today: the actions worth taking, the thing that looks stuck, what's coming up.

**Weekly.** What moved, what didn't, the biggest open loops, and patterns Otto noticed across the week.

Briefs are generated from the knowledge base, not from raw notes — which is what makes them possible at all. They are surfaced in the dashboard rather than pushed, though a tray badge indicates a new brief is waiting.

**Selection rules ship deliberately crude.** What makes something worth surfacing — recency, open loops, imminence, and the thing that has gone quiet — is specified in `salience.md` as a v0 that is legible rather than clever, along with a written list of what it is known to get wrong. It ships that way because briefs cannot wait for usage data that only shipping produces, and because salience is derived: replacing the rules recomputes over all history rather than migrating anything. Expect the first version to over-weight whatever the user wrote about most recently.

## 6. What Otto does not do

- **No collaboration.** Single user, no sharing, no accounts.
- **No manual organisation.** No folders, no user-defined tags, no taxonomy to maintain. If the user has to file something, Otto has failed.
- **Not a task manager.** Tasks exist because notes mention them, not to be managed in Otto. No recurrence, no reminders engine, no scheduling.
- **Not a document editor.** Notes are captures, not documents. No rich text, no wiki links, no page hierarchy. Fixing a mis-heard word in a voice transcript (§5.5) is not an exception to this: it corrects what Otto heard, not what the user meant.
- **No silent destruction.** Otto never removes, merges, or splits without being asked (ADR-0007).
- **No cloud dependency.** Otto works with local inference. Cloud providers are an option for quality, never a requirement to function.

## 7. Scope

### 7.1 MVP

The smallest thing that closes the loop: capture → knowledge base → surfaced back.

- Tray application with quick capture and a full dashboard window
- Voice capture with transcription; typed capture
- Notes stored immutably, browsable, searchable
- Extraction and entity resolution across all five entity types
- Automatic application of confident, non-destructive changes
- Review queue for everything else, with confirm and correct
- Corrections recorded with the user's chosen answer
- Calibration sampling from day one — a slice of confident changes forced into review
- Duplicate detection and merge, with transitive redirects
- Transcript correction
- Dashboard: sidebar navigation, list views with search/sort/filter, entity detail views with relations
- Provenance visible — every fact traceable to its note
- Daily and weekly briefs
- Local inference supported

### 7.2 Deliberately after MVP

- Split (proposal, per-value review affordance) — semantics are decided (ADR-0009) but the review UI is the hard part. Merge moved into MVP (ADR-0012) because without it the knowledge base degrades with use and has no remedy.
- Email, share sheet, and other ingress paths
- Mobile or web clients
- Calendar integration and meeting prep
- Semantic search over notes and entities
- Calibration tooling — threshold tuning against accumulated corrections
- Brief customisation and delivery outside the app

### 7.3 Explicitly not planned

- Multi-user anything
- Publishing or export as a product surface
- Plugin or extension system

## 8. What makes Otto working, working

- The user captures without hesitating, because it costs nothing.
- The knowledge base is accurate enough that the user believes it without checking.
- Opening a Person or Project tells the user something they'd forgotten.
- Corrections are rare, and when needed, trivial.
- The user stops holding open loops in their head.

The failure mode to watch for is the one that kills every system in this category: the user stops trusting it, so they stop capturing, so it decays. Trust is the metric that matters, and visibility plus easy correction is how it's earned.

## 9. Open questions

**No product question blocks implementation.** The four that did are answered: salience and brief content in `salience.md`, the sampling rate in `triage.md` §6, and the split default in ADR-0009 (unclassified values stay with the original identity).

What remains is one technical gate and a set of things that can only be answered by use.

**Gating implementation:** the local-extraction quality measurement (ADR-0013), which decides whether the stated minimum local model is honest. The SQLite spike (`runtime.md` §4) was the other gate and has been run — it passed on all seven bars, so the storage design stands and schema work is unblocked.

**Answerable only by using Otto**, and instrumented so that the answers arrive as data rather than opinion:

- Whether the confidence thresholds are set right. They start deliberately strict and calibration moves them (`triage.md` §2).
- Whether salience v0's known failures are the ones that actually matter (`salience.md` §3).
- Whether the closed relation vocabulary is too small — visible as `relates_to` dominating the graph (`schema.md` §6).
- Whether the field schema is missing fields — visible as the same fact being reinvented in `notes` (`schema.md` §7).
- Whether the review burden during bootstrap is tolerable, or whether 50 corrections is too long to wait.

Each of these has a signal attached rather than a plan to think harder about it later. That is the intended posture: ship the crude version with instrumentation, and let use answer what deliberation cannot.
