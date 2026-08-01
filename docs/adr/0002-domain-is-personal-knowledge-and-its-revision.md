# The domain is personal knowledge and its revision over time

---
Status: accepted
---

Otto's domain is **not note-taking**. Notes are input. The domain is the knowledge structure those notes are *about* — people, projects, ideas, events, tasks, and the relationships between them as they exist in the user's life — together with how the user's understanding of them changes. The test applied throughout: does the concept survive deleting the software? "A person can be mentioned in a note" survives; "confidence score" does not, and is therefore application machinery, not domain.

This framing is load-bearing rather than decorative, because it makes **change, ambiguity, and revision** central rather than incidental. Under it, the event log is not infrastructure — it is the domain model, since the history of how the user came to understand something is part of what they know. Corrections are not error handling; they are revisions of belief, and therefore domain events. It also hands us three concepts a "database of people and projects" framing would treat as painful edge cases: **merge and split** (two entities turning out to be one, or one turning out to be two — a normal operation with real semantics), **assertion vs entity** (ADR-0004), and **salience** (what deserves resurfacing — the one place where forgetting is a feature).

## Consequences

- The "mind/brain" metaphor is adopted for the *shape* of the model only, never the *mechanics*. No module is named after neuroanatomy: such names resolve no design question and forfeit the one thing this vocabulary buys, which is being able to reason in it.
- Merge and split need defined semantics for the afterlife of events attached to pre-merge entities. Settled in ADR-0009: nothing in history is rewritten, and merged-away identities survive as transitive redirects in the projection.
- This ADR's mention of "assertion vs entity" as a concept the framing hands us refers to ADR-0004, since reversed by ADR-0010. The framing's other two gifts — merge/split and salience — stand, and both proved load-bearing (ADR-0009, ADR-0015). The Assertion model did not, which is a point in favour of the framing rather than against it: it made the question askable, and the answer turned out to be no.
