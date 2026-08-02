# The counterfactual is a Command, and the correction corpus survives a rebuild

---
Status: accepted
---

ADR-0006 settled that a correction records what the user chose instead rather than a rejection flag. It did not say what shape "what they chose" has, and building the review queue surfaced two decisions that follow from it. Both are cheap now and expensive after there is a corpus.

**The counterfactual is a `Command`.** The thing the user chose has to be expressible for every entry the queue produces: a different entity for a mis-resolved Mention, a different value for a mis-read field, a different name for a create. The Command vocabulary is already exactly that, already closed (`knowledge-commands.ts`), and already what the executor takes — so the corrected answer is applied by the same path that applies every other change, rather than by a second one that has to be kept in step with the first.

The rejected alternative was a bespoke correction shape carrying a field name and a value. The first thing it would need is a way to say "set this field to that value," which is `SetField` with a different name, and the second is a translator into a Command before anything could be applied. A third vocabulary of change beside Commands and events is a thing that drifts, and the drift would be silent because only the correction path would exercise it.

The cost is that a Correction names a Command whose `expectedVersion` was computed when the user was looking at the queue. That is not new — it is the same optimistic-concurrency stamp every Proposal carries — and it fails the same way, at apply time, into the same re-proposal path.

**A repeat of a correction is identified by the answer, not by the Proposal.** `deriveCorrectionId` hashes the Proposal *and* the chosen Command. Deriving from the Proposal alone would make the id a "this was corrected" key, so a user who corrected a field to one value, thought again, and corrected it to another would have the second answer collapse into the first as a no-op — losing the one they meant. Including the answer makes a double-clicked correction idempotent, which is the case that actually needs collapsing, while a genuinely different answer is a different row and applies normally.

This also fixes an error the user would otherwise see. Without the repeat check, the second submission reaches the executor against an aggregate its own first submission just moved, fails its version check, and surfaces a stale-target error for what is not a stale target. `confirm` needs the same protection and identifies the repeat differently: a confirmation has no answer to compare, so being already stamped as adjudicated is the whole of what a second click would repeat.

**A correction is restamped against the target's current version; a confirmation is not.** The `expectedVersion` on a Proposal exists to catch its target moving while the Proposal waited (`add.md` §5.6) — a check about an *inference* going stale, which is why `confirm` keeps it and a moved target re-proposes.

A correction is not an inference. The user is looking at the entity and stating what it should be, and the most common thing they correct is a change Otto **already applied** — which by definition moved the version past whatever the Proposal carried. Keeping the check there would make auto-applied records uncorrectable in practice, contradicting PRD §5.4's requirement that they stay visible *and* correctable. The alternative was exposing a version on the queue entry for the caller to stamp with, which costs the "correcting is one action" affordance to solve a problem the executor can resolve at apply time.

The Correction stores the Command the user authored, not the restamped one. The corpus should hold what the user chose; a version resolved during application is an artifact of when they clicked.

**`projection_queue_entries` and `projection_corrections` carry the prefix and are exempt from the rebuild list.** `ProjectionStore.reset` is always followed by a replay of the log, so a table belongs in `PROJECTION_TABLES` exactly when folding events puts it back. Neither of these does, and the reasons differ.

Queue entries are rebuildable — by re-running the differ and triage over stored Captures, which is ADR-0019's argument one stage later — but not by replaying the log, because the log records what changed rather than what Otto considered. Emptying them during a rebuild would clear every decision nobody had answered yet, discarding pending work to fix an unrelated corruption.

Corrections are worse to lose, and the asymmetry is the decision. A correction's compensating event carries `humanConfirmedProvenance`, which names no provider and no model version — correctly, because a human confirmed it and there is no inference to describe. So the log cannot say *which model* was corrected, and the bootstrap counter is not derivable from it even in principle. A rebuild that emptied this table would silently return every model to bootstrap and destroy the eval set ADR-0006 calls unreconstructable.

The rejected alternative was dropping the `projection_` prefix from both. It reads as tidier and claims the wrong thing: these are derived rather than truth, droppable by a tool that knows what it is doing, and ADD §10 reserves the prefix for exactly that. The prefix is a claim about ownership, not a promise that `reset` covers them, and `REBUILD_EXEMPT_PROJECTIONS` names them so the distinction cannot read as an oversight.

## Consequences

- **The sampling mark is dropped by the view type rather than by the code that builds it.** `QueueEntryView` has no field it could occupy, so `triage.md` §6's "indistinguishable in the UI" is a property of the type rather than a rule the mapping remembers. A test asserts it over the type's own keys, and a second asserts no `sampl` substring survives to the transport.
- **The queue entry shows no confidence either.** The user is being asked whether Otto got it right, and showing them the number Otto assigned to its own correctness anchors that judgement — biasing exactly the adjudications calibration depends on being independent.
- **`DiscardView` is the affordance.** Three fields, no Command, and nothing a surface could render an Apply button for. `qa.md` §5.7 asks that no apply path exist; the shape is what makes that true, and the method-table test is what keeps it true.
- **Confirming records no Correction.** Agreement is not a counterfactual and teaches the eval set nothing. Only disagreement is data, which means the corpus grows more slowly than the queue empties — and the bootstrap threshold is calibrated against corrections rather than adjudications, so this is the counted thing being the right one rather than a shortfall.
- **`isCounterfactual` checks shape rather than presence, and lives in `domain/`.** A `chosen` arriving as `{}`, as `true`, or as a string is a rejection flag wearing the right type name, and a presence check accepts all three. It is the transport's validator too, because what makes a counterfactual valid is a question about corrections and a second copy at the boundary is one that drifts.
- **Adjudication imports no model-facing port**, so `add.md` §7's "does not re-enter the pipeline" is structural. Asserted against the source alongside the differ's equivalent rule, because a spy proves the call went unmade on one input where the import graph proves nothing could make it on any.
