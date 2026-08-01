# Otto — Confidence, Thresholds, and Disposition

> Status: accepted for MVP. Architecture in [`add.md`](./add.md); field-level model in [`schema.md`](./schema.md); settled decisions in [`docs/adr/`](./adr/).
>
> ADR-0007 decided that triage splits across two layers and that the Confidence number comes from the scorer. It did not say how the two Confidences combine, what the thresholds are, or what happens on day one when no Correction data exists. This document answers those, and completes the application-policy rule table that ADR-0007 left at three rules out of five.

## 1. Two Confidences, and why they stay apart

Extraction reports `p(extraction)` — the probability that the claim it read out of the text is what the text actually said. Resolution produces `p(resolution)` — the probability that the Mention was matched to the right entity. ADR-0007 keeps them separate because the failure modes differ: a bad extraction invents a fact that was never in the note, and a bad resolution attaches a real fact to the wrong entity.

They combine at triage, and the combination is deliberately not a product.

```
p(correct) = p(extraction) × p(resolution)      -- when both apply
p(correct) = p(extraction)                       -- creates, and field changes on an already-resolved entity
```

The multiplication treats the two as independent, which they are not — a Capture whose text was misread tends to also resolve badly — so the product is a conservative estimate. Being conservative in this direction is the correct bias: it pushes marginal cases toward review rather than toward silent application, which is the direction ADR-0007 and PRD §4.4 both choose everywhere else.

**Where `p(resolution)` comes from.** The scorer, never the model's self-report. Features are name similarity, co-occurrence with other entities resolved in the same Capture, recency of contact, and type agreement (ADD §5.3). When LLM adjudication runs, its choice selects *which* candidate, and the scorer's margin between the top two candidates supplies the number — an adjudicated pick among near-identical candidates is not made confident by having been adjudicated.

**Where `p(extraction)` comes from.** This one has no scorer, and pretending otherwise would be dishonest. It is the model's own report, and it is therefore **treated as a floor rather than a probability until calibration has data**: §4 describes the bootstrap under which it cannot on its own lift a proposal into auto-apply.

## 2. Thresholds

Keyed by provider and model version (ADR-0008), stored in `inference/calibration/thresholds.ts` as data, not scattered as literals.

| Band | `p(correct)` | Disposition |
|---|---|---|
| High | `≥ 0.90` | `auto_apply`, subject to the application policy (§3) |
| Middle | `0.50 – 0.90` | `needs_review` |
| Low | `< 0.50` | `discard` |

These three numbers are **initial values, chosen to be wrong in the safe direction**, and the entire calibration apparatus (ADR-0006) exists to replace them with measured ones. Two notes on how they were picked:

**0.90 is high on purpose.** At single-user volume the cost of an extra review is a few seconds; the cost of a confidently wrong auto-apply is a fact the user believes and does not check. Those are not symmetric, and the threshold should not be either. Expect the measured value to move *down* as calibration data arrives, and treat any impulse to move it down before then as the thing calibration exists to prevent.

**0.50 is a floor, not a judgement.** Below even odds, showing the user a proposal costs them more attention than the proposal is worth. Discarded proposals are recorded, not deleted (§6), so a threshold that turns out to be too aggressive is recoverable by examining what it discarded.

## 3. The application policy: the complete rule table

`domain/policies/application-policy.ts`. Pure, no I/O, and it never reads a Confidence — it is asked about a *kind of change* (ADR-0007). It may only downgrade a Disposition, never upgrade one.

| Command kind | Policy | Why |
|---|---|---|
| `create` — new entity | **downgrade to `needs_review`** when resolution considered and rejected candidates; permit when there were none | A create made after rejecting a real candidate is the decision that manufactures duplicates. See below. |
| `update` — field change, `auto` floor | permit | The ordinary case, and the one that makes Otto feel automatic. Additive and reversible. |
| `update` — field change, `review` floor | **downgrade to `needs_review`** | Per-field floors from `schema.md` §1: `name` on any entity, `became` relations. |
| `update` — relation add | permit | Additive and reversible, same as a field. |
| `remove` — field value, relation, or entity | **downgrade to `needs_review`**, always | ADR-0007. Destructive at any Confidence. |
| `merge` | **downgrade to `needs_review`**, always | ADR-0007, ADR-0009. |
| `split` | **downgrade to `needs_review`**, always | ADR-0007, ADR-0009. |

**The `create` rule needs its exception explained**, because it is the one place this table is more permissive than a flat reading of "creates are additive."

A note saying "had lunch with Priya about the Meridian rollout" mentions two things Otto has never seen. Sending both to review makes the very first use of Otto a form to fill in, which is the failure PRD §4.1 is built to avoid. So a `create` **auto-applies when the Mention is unambiguous** — meaning candidate generation returned nothing above the noise floor, so there is no entity this could plausibly be instead. That is the case where creating is not a guess.

A `create` **goes to review when candidates existed and were rejected** — when resolution found a Sarah, scored her, and decided this is a *different* Sarah. That decision is exactly the one that produces duplicates, and it is the one worth a human glance. This is the same asymmetry ADR-0009 describes from the other side: resolution biases toward "none of these," and this rule catches the cost of that bias at the point where it is cheapest to correct.

## 4. Bootstrap: the first hundred Captures

On day one there are no Corrections, so the thresholds in §2 are guesses and `p(extraction)` is an uncalibrated self-report. Shipping with confident auto-apply under those conditions would mean the period when Otto is least trustworthy is also the period when it acts most freely.

**Bootstrap mode**: until **50 Corrections** have accumulated for the active provider and model version, `p(extraction)` is capped at `0.90` for the purpose of triage. Because the product in §1 then cannot reach the 0.90 band on any proposal that also required resolution, the practical effect is that **only unambiguous creates and updates to already-resolved entities auto-apply** during bootstrap. Everything requiring a resolution judgement waits.

Fifty is ADR-0006's own minimum for an eval set, and it is reached quickly — a Capture typically produces several proposals. Bootstrap mode is per provider and model version, so switching models re-enters it. That is correct and not an inconvenience: a threshold measured against one model says nothing about another (ADR-0008).

Bootstrap status is visible in the dashboard rather than silent, since a user wondering why Otto is asking so many questions deserves the answer that it is still learning what it is worth.

## 5. Duplicates before merge exists

Resolution is biased toward "none of these" (ADR-0009), which produces duplicates by design. The PRD originally deferred all of merge, which would have shipped an MVP with the failure mode and no repair.

Three things close that gap without pulling the full merge/split review UI forward.

**The `create` review rule above** catches most duplicates before they exist, at the moment Otto is deciding to create a second Sarah rather than weeks later.

**Duplicate detection is a projection.** Entity pairs above a similarity threshold are surfaced in the review queue as a suspected-duplicate entry. This is candidate generation pointed at the entity table instead of at a Mention, so it reuses machinery that already exists for resolution.

**A minimal merge ships in MVP.** Not the full ADR-0009 affordance — no split, no per-fact classification UI — but `EntitiesMerged` with transitive redirects, applied to a pair the user confirms from the review queue. Field conflicts resolve by keeping the survivor's value and moving the loser's into `notes`, which is lossless and needs no interface. This is a scope addition to PRD §7.1, made deliberately: the alternative is an MVP whose knowledge base degrades with use and has no remedy.

**Split stays deferred**, unchanged. It is the half that genuinely needs the review UI (ADR-0009), and unlike merge it has no cheap lossless fallback.

## 6. Calibration sampling

ADR-0006 requires that a slice of confident auto-applies be forced into review, or the Correction log only ever describes the middle band and says nothing about whether 0.90 is too loose.

**The rate is 10%, and it decays.**

| Corrections accumulated | Sampling rate |
|---|---|
| 0 – 50 (bootstrap) | 20% |
| 50 – 500 | 10% |
| 500+ | 5% |

Sampled proposals are marked as such, appear in the review queue indistinguishably from ordinary ones, and their Adjudications are the only unbiased measurement Otto has of its own error rate. The decay reflects that early data is worth more per item than late data, and that the friction should fall as trust is earned.

At a plausible early volume — a few Captures a day, several proposals each — 10% is roughly one extra review a day. That is the cost, stated plainly, and it buys the only number in the system that is not a guess.

**Sampling is not optional and has no user-facing off switch.** An instrument that can be disabled will be, on the day it is most annoying, which is the day the data matters most.

## 7. Discarded proposals are visible

Triage has three outcomes, and PRD §5.4 only described two arriving in the queue. Left there, `discard` means Otto silently drops things — which sits badly against the principle that the user can always see what Otto did (PRD §4.3).

Discarded proposals are **recorded and shown in a collapsed "not acted on" section of the review queue**, defaulting to hidden, retained for 30 days. The user never has to look. But "why didn't Otto pick that up?" has an answer, and the low threshold has an audit trail.

This is a deliberately small surface: a list of what was dropped and from which Capture, with no affordance to act on it beyond re-capturing. Making discards actionable would turn the low band into a second review queue, which is exactly what the threshold exists to prevent.

## 8. Staleness at apply time

A proposal stamped with an aggregate version that no longer matches fails its check and is re-proposed against current state (ADD §5.6). Three details that the executor needs and the ADD left implicit:

**Re-proposal is a pipeline re-entry from the differ, not from extraction.** The extracted values are still valid — the text did not change. Only the comparison against current state is stale. This is cheap and involves no LLM call.

**A re-proposal that produces no change is closed, not re-queued.** If the user's own edit already made the change the proposal wanted, the proposal is satisfied. It is recorded as such rather than shown again.

**A re-proposal that produces a different change goes to review regardless of Confidence**, because the user was already looking at this one and the thing they were looking at changed underneath them.
