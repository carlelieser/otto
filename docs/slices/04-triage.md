# Slice 4 — Triage

> Depends on: Slice 3. Blocks: Slice 5.
> Sources: [`triage.md`](../triage.md) (all); [`add.md`](../add.md) §5.5, §5.6; [`qa.md`](../qa.md) §5; ADR-0006, ADR-0007, ADR-0012.

## What it closes

A Proposal becomes a decision: applied unattended, held for the user, or discarded and recorded. The write path is complete from this slice on — a spoken note becomes an event in the log without a human touching it, when and only when Otto is confident enough and the change is the kind that may happen unattended.

## Why here

This is where trust is won or lost, and it is almost entirely pure functions with zero I/O (ADR-0007). `qa.md` §12 puts the Tier 1 pure tests at step 3 — before any infrastructure — precisely because they need no fixtures and carry the highest value per unit of effort in the plan. The functions can be written earlier than this slice; the slice is where they are wired to real Proposals.

**Calibration sampling ships here and cannot ship later.** ADR-0006 is emphatic that it cannot be reconstructed retroactively: without it the correction log only ever describes the review band and says nothing about whether the auto-apply threshold is too loose. It exists from the first commit that has an auto-apply band to sample from, which is this one.

## In scope

**Confidence combination** (`triage.md` §1), as a product:

```
p(correct) = p(extraction) × p(resolution)   -- when both apply
p(correct) = p(extraction)                    -- creates, and field changes on an already-resolved entity
```

The multiplication assumes an independence that does not hold and therefore underestimates. The bias is deliberate and points where every other decision here points: toward review.

**Thresholds** (`triage.md` §2), keyed by provider and model version, stored in `inference/calibration/thresholds.ts` **as data, not scattered as literals**: `≥ 0.90` auto-apply, `0.50–0.90` review, `< 0.50` discard. These are initial values chosen to be wrong in the safe direction, and the whole calibration apparatus exists to replace them with measured ones.

**The application policy** — `domain/policies/application-policy.ts`. Pure, no I/O, and it **never reads a Confidence**: it is asked about a *kind of change*. It may only downgrade a Disposition, never upgrade one. The complete rule table is `triage.md` §3, and the `create` row is the subtle one:

- `create` with an unambiguous Mention — candidate generation returned nothing above the noise floor — **permits auto-apply**. Sending every first-ever mention to review would make the first use of Otto a form to fill in, which is the failure PRD §4.1 is built to avoid.
- `create` where candidates existed and were rejected — **downgrades to review**. That decision is exactly the one that manufactures duplicates, and it is the one worth a human glance.

**Two homes for two questions** (`add.md` §5.5). `inference/calibration/` answers "is this proposal likely enough to be correct?" — a question about Otto's machinery. `domain/policies/` answers "what kinds of change may happen to knowledge without a human looking?" — a question about the user's tolerance for damage, true regardless of whether the change came from an LLM or a human. The rule that settles the placement is `remove`, which never auto-applies at any confidence: a rule that does not read the number it is supposedly about belongs with the rules about knowledge.

**Bootstrap** (`triage.md` §4). Until **50 Corrections** accumulate for the active provider and model version, `p(extraction)` is capped at 0.90 for triage purposes. The practical effect is derived rather than stated as a rule: only unambiguous creates and updates to already-resolved entities auto-apply, because 0.90 × anything < 1 is below 0.90. Per provider and model version, so switching models re-enters it — correct, and not an inconvenience.

**Calibration sampling** (`triage.md` §6), realised as a downgrade. Rates decay with accumulated corrections: 20% at 0–50, 10% at 50–500, 5% at 500+. Sampled proposals are marked in the data and appear in the review queue **indistinguishably from ordinary ones** — both halves matter, since a user who knows they are being measured adjudicates differently. **There is no off switch**: an instrument that can be disabled will be, on the day it is most annoying, which is the day the data matters most.

**Discards recorded, not dropped** (`triage.md` §7). The low band writes a `discard` disposition retained for 30 days. Silent omission is the one triage outcome invisible to the user, and invisible is what kills trust.

**Staleness at apply time** (`triage.md` §8, `add.md` §5.6). A Proposal stamped with an aggregate version that no longer matches fails its check and is re-proposed against current state. **Re-proposal re-enters from the differ, not from extraction** — the text did not change, only the comparison against current state, so there is no LLM call. A re-proposal producing no change is **closed, not re-queued**. One producing a *different* change goes to review **regardless of confidence**, because the thing the user was looking at changed underneath them.

**The full executor path.** Triage's `auto_apply` goes to the executor and becomes an event in the log.

## Not in scope

- **The review queue as a surface.** Slice 6. Proposals are given a disposition here and stored; the user cannot see or act on them yet.
- **Corrections.** Slice 6. Bootstrap counts corrections, and until Slice 6 exists that count is zero — which means this slice ships in permanent bootstrap, and that is the correct behaviour rather than a gap.
- **Threshold calibration tooling.** Post-MVP (PRD §7.2). Sampling gathers the data here; the tuning tool that consumes it does not ship in MVP.
- **Merge and split dispositions.** The policy rows exist and are tested at confidence 1.0 here; the merge *mechanism* is Slice 7 and split never ships in MVP.

## Build order

1. Confidence combination — pure, both cases including the boundary where no resolution judgement was involved.
2. The threshold table as data, keyed by provider and model version.
3. The application policy — the complete `triage.md` §3 rule table.
4. Wiring: calibration proposes a disposition, the policy may downgrade it, control flows one way.
5. Bootstrap: the correction count per provider and model version, and the cap.
6. Calibration sampling, with the sampled mark in the data and no configuration path to disable it.
7. Discard recording with 30-day retention.
8. Staleness checks at apply time and the re-proposal path from the differ.

## Verification

Tier 1 (`qa.md` §5), exhaustive over the rule table — "there is no excuse for incomplete coverage here."

**The application policy:**

- Every row of `triage.md` §3 gets a test.
- **Property-based: for any proposed disposition and any command kind, the output is never less restrictive than the input.** This one property catches a class of future bug that row-by-row tests miss.
- **`remove`, `merge`, and `split` are tested at confidence 1.0 specifically.** The rule is "never, at any confidence," and the only test that verifies "at any confidence" is one that passes the maximum and still expects a downgrade.
- The policy's signature does not accept a Confidence. Structural, and checkable.
- It is pure. If a test for the application policy needs a database, the policy is in the wrong place.

**Thresholds:**

- Boundaries exactly: 0.90 auto-applies, 0.8999 reviews, 0.50 reviews, 0.4999 discards.
- A Proposal is triaged against **its own** model's thresholds, not the currently-active model's. ADR-0008 calls retrofitting this genuinely painful.
- A grep test for numeric threshold literals elsewhere in `inference/`.

**Bootstrap:**

- A proposal requiring resolution, at maximum confidence on both figures, still does not auto-apply during bootstrap.
- Switching models re-enters bootstrap even if 50 corrections exist for the previous model.
- The 50th correction exits bootstrap; the 49th does not.

**Sampling:**

- Tier boundaries: 20% / 10% / 5%.
- Sampled proposals are marked in the data and indistinguishable in the UI.
- **No configuration path disables sampling** — no environment variable, no settings toggle, no debug flag.
- Statistical sanity over a large synthetic run: a range, not an exact assertion.

**Staleness:**

- A stale Proposal fails its version check and is re-proposed rather than applied blindly.
- **Re-proposal does not invoke the extractor port.** Assert the absence of the call.
- No-change re-proposal is closed, not re-queued; different-change re-proposal reviews regardless of confidence.

## Done when

- A Capture runs end to end: ingested, extracted, resolved, differed, triaged, and — when confident and non-destructive — applied to the log with no human involved.
- Every row of the `triage.md` §3 table is covered, with the three destructive rows tested at confidence 1.0.
- Sampling fires at the bootstrap rate and cannot be turned off.
- Discarded proposals are retrievable and name their originating Capture.
