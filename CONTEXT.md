# Otto

A private, local, cross-platform system for personal knowledge. Its subject matter is not note-taking but **what one person knows and how their understanding of it changes over time** — the people, projects, ideas, events, and tasks in their life, and the revisions their beliefs about those things undergo.

## Language

### Knowledge

**Person**:
Someone in the user's life, with an identity that persists through renaming.
_Avoid_: Contact, individual, user (the user is the one person Otto belongs to, never an entity in the graph)

**Project**:
An ongoing effort the user is involved in, which may outlive the people associated with it.
_Avoid_: Initiative, workstream

**Idea**:
A thought worth keeping that is not yet a Project or a Task.
_Avoid_: Thought, concept, note (a Note is input; an Idea is knowledge extracted from one)

**Event**:
Something that happened or will happen at a point in time. Distinct from a domain event, which is a record of a change to Otto's own state.
_Avoid_: Occurrence, meeting, appointment

**Task**:
Something the user intends to do.
_Avoid_: Todo, action item, action (an Action would be confused with a Command)

**Relation**:
A named link between two entities, itself inferred and revisable rather than intrinsic.
_Avoid_: Link, edge, connection, association

**Field**:
A typed, named thing Otto may know about an entity, declared in the schema rather than invented by extraction. Single-valued fields are superseded on change; set-valued fields accumulate.
_Avoid_: Attribute, property, column, assertion (Assertions were reversed by ADR-0010 and are not part of the model)

**Salience**:
How much an entity deserves the user's attention now. The measure behind resurfacing, and the one place where forgetting is a feature.
_Avoid_: Relevance, score, priority, weight

**Merge**:
Recording that two entities were always one. Supersedes the earlier belief rather than contradicting it — Otto was not wrong to have thought there were two.
_Avoid_: Deduplicate, link, combine

**Split**:
Recording that one entity was always two.
_Avoid_: Fork, divide, separate

**Redirect**:
A merged-away identity's continued resolvability to its survivor. Invisible to the user; it exists because references made before a Merge remain valid afterward.
_Avoid_: Tombstone, alias, pointer, forward

### Pipeline

**Capture**:
A single immutable record of something the user put into Otto, normalised from whatever form it arrived in. The origin of all provenance.
_Avoid_: Input, entry, note, submission, ingestion (Ingestion is the act, a Capture is its product)

**Ingestion**:
The act of turning arriving input into a Capture — transcription, cleanup, deduplication, timestamping. Carries no semantic reasoning.
_Avoid_: Import, parsing, preprocessing

**Extraction**:
Reading a Capture and producing structured Mentions and claims from it. Depends on nothing but the text.
_Avoid_: Parsing, understanding, analysis

**Mention**:
A reference to an entity as it appeared in a Capture, before it is known which entity it refers to — or whether that entity exists yet.
_Avoid_: Reference, match, candidate (a Candidate is a possible resolution *for* a Mention)

**Resolution**:
Deciding which existing entity a Mention refers to, or that it refers to none.
_Avoid_: Matching, linking, reconciliation, disambiguation

**Candidate**:
An existing entity that a Mention might refer to, retrieved for scoring.
_Avoid_: Match, suggestion, possibility

**Proposal**:
A suggested change to knowledge, carrying its Confidence and its Provenance, awaiting Triage. Not yet true of the world.
_Avoid_: Suggestion, recommendation, change request

**Command**:
An expressed intent to change knowledge, in the imperative and naming its target. May be refused.
_Avoid_: Action, operation, mutation, request

**Domain event**:
A record that knowledge did change. Past tense, immutable, never refused, never deleted, and never carrying a Confidence.
_Avoid_: Change, update, log entry, message

**Confidence**:
How likely a Proposal is to be correct, kept as separate figures for extraction and for resolution rather than blended into one. A property of Otto's machinery, never of knowledge itself.
_Avoid_: Score, probability, certainty, accuracy

**Triage**:
Deciding a Proposal's Disposition from its Confidence.
_Avoid_: Routing, filtering, gating

**Disposition**:
What Triage decided should happen to a Proposal: apply it, review it, or discard it.
_Avoid_: Decision, outcome, verdict, status

**Review queue**:
The Proposals awaiting the user's judgement.
_Avoid_: Inbox, pending, notifications

**Adjudication**:
The user judging a Proposal in the Review queue. Ambiguously also used for the LLM's choice among Candidates; prefer *candidate adjudication* for the latter when both are in play.
_Avoid_: Approval, confirmation, validation

**Correction**:
A record of what the user judged to be right, including what they chose instead. A revision of belief, not the repair of an error.
_Avoid_: Fix, rejection, feedback, undo

**Provenance**:
Where a piece of knowledge came from — which Capture, which Proposal, which model and version, at what Confidence, and whether a human confirmed it.
_Avoid_: Source, metadata, audit, origin

**Lineage**:
The full chain from Capture through Proposal and domain event to current knowledge.
_Avoid_: History, trail, path

**Projection**:
Knowledge in a shape built for reading, derived entirely from the event log and safe to discard and rebuild.
_Avoid_: View, cache, index, read model, materialized view

**Calibration**:
Checking claimed Confidence against what Corrections show actually happened, and adjusting thresholds accordingly.
_Avoid_: Tuning, training, learning

**Sampling**:
Deliberately sending a slice of Proposals that Triage would have applied unattended to the Review queue anyway, so that Calibration has unbiased evidence about the auto-apply band. Not a test of the user.
_Avoid_: A/B, holdout, spot check

**Bootstrap**:
The period before enough Corrections exist to trust a model's Confidence, during which auto-apply is constrained. Per provider and model version, so changing models re-enters it.
_Avoid_: Warmup, training period, onboarding

**Date precision**:
How exactly a date is known — from an exact timestamp down to an unresolved phrase like "when the contract lands". Carried alongside the date so that a vague date is never rendered as a specific one.
_Avoid_: Granularity, fuzziness, accuracy
