# Assertions are first-class entities, not fields on entities

---
Status: superseded by ADR-0010
---

> **Superseded.** Entities carry real fields; Assertions are not part of Otto's model. See [ADR-0010](./0010-entities-carry-fields-assertions-reversed.md). Retained for the reasoning, which remains the argument to answer if the decision is ever revisited.

A claim such as "Sarah works at Acme" is stored as an **Assertion** record — subject, predicate, object, plus the capture it came from, the proposal that produced it, the model and version that inferred it, its confidence, and two independent time ranges: when the claim was *true* and when we *learned* it (bitemporal modelling). It is not a column on `person`. Consequently `Person`, `Project`, `Idea`, `Event`, and `Task` are thin — identity, aliases, timestamps — and the Assertion log carries the substance of the model.

The reason is that Otto's domain is revision (ADR-0002), and revision is exactly what a field cannot represent. "Sarah works at Acme" can become false without ever having been wrong, which as a column is a lost UPDATE and as an Assertion is a superseded record with an intact predecessor. It also makes contradiction a first-class state — two live assertions disagreeing — rather than a write that silently clobbers the earlier belief. Per-claim provenance is the other half: recording which capture and which model version produced each individual claim is what makes ADR-0006's calibration meaningful, and it cannot be reconstructed after the fact from entity-level change rows.

## Considered Options

- **Attributes as fields, provenance on a change log** — simpler queries, much thinner `domain/`, and `inference/` would become the bulk of the system. Rejected because retrofitting per-claim provenance is the expensive direction: it would require replaying every capture through extraction to recover information that was never recorded.
- **Defer and migrate later** — same objection. The migration cost is paid in exactly the scenario where we have most data.

## Consequences

- Reads get harder. Current state for an entity is a query over live assertions, not a row. Expect this to be the main driver of projection complexity under ADR-0005.
- "What does Otto believe about Sarah *right now*" and "what did Otto believe last March" become the same query with a different time parameter, which is the payoff.
- Entity merge and split (ADR-0002) must define what happens to assertions attached to the pre-merge entities. Undesigned.
