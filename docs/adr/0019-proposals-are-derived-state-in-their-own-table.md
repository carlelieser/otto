# Proposals are derived state in their own table, not a third table that is truth

---
Status: accepted
---

Extraction's output is recorded in `extraction_proposals`, a third SQLite table beside `captures` and `events`. **It carries no immutability triggers, and that asymmetry is the decision.**

ADR-0011 and `add.md` §10 make `captures` and `events` insert-only at both the application and database levels, on the grounds that a corrupt log is the only unrecoverable failure in the system. The obvious move on adding a third table is to protect it the same way. That would be wrong, and it would be wrong in a way that reads as consistency.

**A Proposal is not a change to knowledge.** It is a claim awaiting triage, and most never become events at all — a discarded Proposal is recorded and never applied (`add.md` §5.5). Putting Proposals in the event log would make the log a record of what Otto *considered* rather than of what changed, which is the distinction ADR-0004 and ADR-0002 both rest on.

**A Proposal is reproducible from its inputs.** `runtime.md` §3 derives `proposal_id` from the Capture id, the stage, the provider, the model version, and an ordinal — so a Proposal is a pure function of a stored Capture and a named model. That is the definition of derived state (ADR-0005), and derived state is rebuildable rather than protected.

**Protecting it would forbid the thing it enables.** Re-extraction under a better model is a scoped manual action `runtime.md` §3 explicitly supports, and it is what makes a knowledge base survive a model upgrade. Immutability triggers on this table would turn that into a schema migration.

## Consequences

- **The resumption check is the rows themselves.** `CaptureExtraction` asks the store whether a Capture has Proposals rather than reading a per-stage status column, which keeps the resumption point derivable from what is stored — the same property the startup sweep's anti-join has (Slice 2). A status column would be a second truth that can disagree with the rows it describes.
- **The insert is transactional.** A partial write would leave a Capture that *looks* extracted and is missing Mentions, and the worker would resume past a call that never finished. All-or-nothing turns a crash mid-write back into the case the check already handles.
- **A Capture that legitimately yielded nothing is re-extracted.** No Proposals is also what an unrun Capture looks like, and this table stores no "ran and found nothing" marker. Accepted: extraction is deterministic at temperature 0, so the second run produces the same nothing, and the alternative is the status column above.
- **The Mention is stored as JSON, not as columns.** It is read whole by the next stage and never queried by field. A row per claimed field value would be a schema that has to change every time `schema.md` does, which is the coupling the generated output schema exists to keep in one place.
- **A projection over Proposals is available later without a migration**, because the rows are derived and can be rebuilt. Slice 7's review queue is the first consumer that will want one.
