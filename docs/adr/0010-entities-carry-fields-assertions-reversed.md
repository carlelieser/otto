# Entities carry fields; ADR-0004 is reversed

---
Status: accepted
Supersedes: ADR-0004
---

`Person`, `Project`, `Idea`, `Event`, and `Task` carry **real fields**. "Sarah works at Globex" is an `employer` column on `person`, not an Assertion record. The pipeline is unchanged in shape — a Capture produces Proposals, Proposals become Commands, the executor applies them — but a Command now targets fields on an entity, and the differ compares extracted values against current ones to decide create versus update. Cardinality is a property of the schema rather than of a predicate vocabulary: `employer` is a string and gets replaced, `tags` is an array and accumulates, and the differ knows which because it is typed.

ADR-0004 argued that a claim can become false without ever having been wrong, and that a field cannot represent that. This is true and it is not sufficient. The revision history it describes is already carried by the event log (ADR-0005): every change event records which Capture, which Proposal, which model and version, at what Confidence, and whether a human confirmed. Lineage and time-travel survive intact. What Assertions bought over and above that was **contradiction as a live state** — two beliefs disagreeing simultaneously, neither superseding the other — and nothing in the product requires it. Otto's job is to hold a current, accurate picture and surface it; when a note says something new, the answer is that the new thing is now true.

Against that, the costs were concrete. Reading "what does Otto know about Sarah" became a synthesis over stacked Assertions rather than a row, which ADR-0004 itself conceded would be "the main driver of projection complexity." The predicate vocabulary became an open design problem with no good answer — a closed set means new kinds of claim need a code change, an open set means extraction invents predicates and the graph fragments. And an entity reduced to identity and aliases is not a model of anything; it is a join key.

The provenance-in-hindsight objection from ADR-0004 — that retrofitting per-claim provenance would require replaying every Capture through Extraction — does not apply, because the information is not being discarded. It moves from Assertion rows to change events, which are equally durable and equally queryable.

## Considered Options

- **Keep Assertions (ADR-0004 as written)** — rejected: the complexity is real and continuous, and the capability it buys has no requirement behind it.
- **Hybrid: typed columns for stable single-valued attributes, Assertions for open-ended claims** — rejected for now. It is the reasonable escape hatch if contradiction ever turns out to matter, but adopting it pre-emptively means paying the Assertion complexity in full while also maintaining a second model.

## Consequences

- **ADR-0005 stands unchanged.** Event sourcing was justified in part by ADR-0004 making the log the model, and that justification is now gone — but Otto is event-driven and event-sourced because that is the shape of the system, not because Assertions demanded it. The log remains the sole source of truth and entity tables remain rebuildable projections.
- **Reads are plain queries.** The Person view is a select against the projection plus its relations. This removes the "current-state query shape" question that ADR-0004 opened.
- **The predicate vocabulary question is closed** — there is no predicate vocabulary. Fields are declared in the schema, and adding a new kind of claim is a schema change, which is the honest cost.
- **Bitemporality is not modelled.** "What did Otto believe last March" is answerable by replaying the log to a point in time, but it is no longer a query parameter on live data. Accepted: no requirement asks for it.
- **Contradiction becomes supersession.** When a new value arrives for a single-valued field, the old one is superseded rather than held alongside. If a case ever emerges where holding both is genuinely necessary, revisit the hybrid option above rather than reinstating Assertions wholesale.
- `Assertion` is removed from the vocabulary in `CONTEXT.md`. ADR-0004 and ADR-0009 both reference it and need amending.
