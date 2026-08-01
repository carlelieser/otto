# Merge and split are events; merged-away identities survive as redirects

---
Status: accepted
---

> **Amended.** The split default this ADR left open is settled below. Scope changed after [ADR-0012](./0012-thresholds-bootstrap-and-minimal-merge.md): a **minimal merge ships in the MVP** — `EntitiesMerged` with transitive redirects over a user-confirmed pair, with field conflicts resolved by keeping the survivor's value and moving the loser's into `notes`. The semantics below are unchanged; only the timing is. **Split remains deferred**, since it is the half that genuinely requires the per-value review affordance.

Two Person records referring to one human is the expected steady-state outcome of resolution under uncertainty, not a bug to be eliminated. ADR-0007 deliberately biases toward creating a duplicate rather than misattributing a fact, because a duplicate is recoverable and a misattribution quietly corrupts knowledge. **Merge** is therefore a normal operation with real semantics, and **split** is its mirror: one identity that was always two.

Both are recorded as domain events — `EntitiesMerged`, `EntitySplit` — appended to the log like any other. Nothing in history is rewritten. `PersonCreated(#4891)` and every change event recorded against #4891 remain exactly as they were, because they record what Otto believed at the time, and at the time it genuinely believed there were two Sarahs. The merge does not falsify that; it supersedes it.

The projection is where the change shows. Rebuilt from the log, it produces one Sarah after the merge event, and #4891 does not appear in the people list or anywhere else in the UI. But it survives in the projection as a **redirect**: a tombstone row mapping the merged-away id to its survivor. Reads resolve through it, which handles both places a dead id can still be encountered — a proposal queued before the merge that targets #4891 and is approved a week later, and provenance display for a January change event whose target is, immutably, #4891. Both resolve to Sarah; neither requires touching the review queue at merge time or rewriting an event.

## Consequences

- **Merge and split never auto-apply** (ADR-0007), at any confidence. Otto proposes them freely; they wait in the review queue like any other proposal.
- **Split cannot be fully derived.** Merge has one obvious destination for everything recorded — the surviving identity. Split must decide, per recorded field value and relation, which of the two identities it concerned. Some are recoverable from the source Capture, many are not. This needs a review affordance that presents each value with its originating Capture, and a default disposition for the ones the user does not classify.
- **The split default is settled: unclassified values stay with the original identity.** The new identity starts with only what the user explicitly assigns it. The alternative — duplicating unclassified values to both — manufactures facts about the new identity that no Capture ever supported, which is the failure mode the whole write path is built to prevent. Staying put is recoverable by a later edit; invented facts are not, because nothing marks them as invented.
- Redirects are transitive. Merging #4891 into #4172 and later #4172 into #5310 must resolve #4891 → #5310, so redirect resolution follows chains rather than assuming one hop.
- Splitting an entity that was previously merged is legal and is not an "unmerge" — it produces two new identities from the current one, and the old redirect still points at whichever survivor the split assigns it to.
