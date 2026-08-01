# Slice 7 — Duplicates and merge

> Depends on: Slice 6. Independent of Slices 8 and 9.
> Sources: [`prd.md`](../prd.md) §5.6; [`add.md`](../add.md) §6; [`triage.md`](../triage.md) §5; [`qa.md`](../qa.md) §7.4; ADR-0009, ADR-0012.

## What it closes

Two entities that were always one become one, confirmed by the user from the review queue, with nothing lost from either and every reference made before the merge still resolving afterwards.

This closes the cost of a bias taken deliberately upstream. Resolution prefers "none of these" over a wrong match (ADR-0009) because a duplicate is visible and fixable while a misattribution quietly corrupts what the user knows. That trade is only honest if the fix exists.

## Why here

Merge is in MVP as a **scope addition to PRD §7.1, made deliberately** (ADR-0012, `triage.md` §5): the alternative is an MVP whose knowledge base degrades with use and has no remedy. It comes after the review queue because a merge is confirmed from the queue and never happens unattended at any confidence.

It is cheap here for a specific reason: **duplicate detection is candidate generation pointed at the entity table instead of at a Mention**, so it reuses machinery Slice 3 already built.

## In scope

**Duplicate detection as a projection.** Entity pairs above a similarity threshold surface in the review queue as suspected-duplicate entries.

**`EntitiesMerged` as an event.** Nothing in history is rewritten. `PersonCreated(#4891)` and every event against #4891 remain exactly as they were — the projection is where the change shows.

**Transitive redirects.** The merged-away identity survives as a redirect row that reads resolve through, and **chains are followed rather than assumed to be one hop**: merging #4891 into #4172 and later #4172 into #5310 must resolve #4891 all the way to #5310 (ADR-0009). This is what lets a proposal queued before a merge be approved a week later without the merge having had to touch the review queue.

Redirects are invisible to the user. They exist because references made before a merge remain valid afterward.

**Lossless field conflict resolution** (`triage.md` §5): the survivor's value is kept and the loser's moves into `notes`. This needs no interface, which is exactly why minimal merge can ship without the full ADR-0009 affordance.

**Merge always waits for the user**, at any confidence, per the application policy row Slice 4 already built and tested at 1.0.

## Not in scope

- **Split.** Deferred, and the deferral is the point (PRD §7.2, ADR-0009). Semantics are settled — unclassified values stay with the original identity — but the per-value review affordance is real interface work and, unlike merge, split has no cheap lossless fallback. **Test that no split path exists** rather than testing split behaviour.
- **Per-fact classification UI.** The full ADR-0009 affordance. Not in minimal merge.
- **Unmerge.** Not specified anywhere and not implied; a merge is a recorded belief that two things were always one, revisable the way any belief is rather than by an undo button.

## Build order

1. The similarity projection over the entity table, reusing Slice 3's candidate generation.
2. Suspected-duplicate entries into the review queue.
3. `EntitiesMerged` through the executor, and the `redirects` projection.
4. Transitive chain resolution in reads.
5. Field conflict resolution — survivor's value kept, loser's into `notes`.
6. Provenance resolution through redirects.

## Verification

Tier 2 (`qa.md` §7.4), with the transitivity property carrying the most rigour:

- `EntitiesMerged` produces one entity in the projection; the merged-away id does not appear in any list view.
- **Redirects are transitive. Property-based over arbitrary chain lengths** — "follows chains rather than assuming one hop" is precisely the bug a one-hop implementation passes an example test for. ADR-0009's own example (#4891 → #4172 → #5310) is the minimum case, not the test.
- A proposal queued *before* a merge, approved a week after, resolves through the redirect and applies to the survivor — without the merge having touched the review queue.
- Provenance display for a pre-merge event whose target is immutably the old id resolves to the survivor.
- Field conflicts keep the survivor's value and move the loser's into `notes` — lossless.
- **Nothing in history is rewritten.** Every event against the merged-away id remains exactly as it was.
- Duplicate detection surfaces suspected pairs into the review queue.
- **Split is not implemented.** Test that no split path exists.
- Merge never auto-applies at any confidence — the Slice 4 policy test, re-verified against the real merge path.

## Done when

- A suspected duplicate pair appears in the review queue and the user's confirmation merges them.
- Redirect chains of arbitrary length resolve to the final survivor, verified as a property.
- A pre-merge proposal approved post-merge applies to the survivor.
- No split path exists anywhere in the codebase.
