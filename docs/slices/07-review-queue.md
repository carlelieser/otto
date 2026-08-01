# Slice 7 — Review queue

> Depends on: Slice 6. Blocks: Slices 8, 9, 11.
> Sources: [`prd.md`](../prd.md) §5.4, §5.5; [`add.md`](../add.md) §7; [`triage.md`](../triage.md) §4, §6, §7; [`qa.md`](../qa.md) §7.7, §10; ADR-0006.

## What it closes

The user sees what Otto decided and can confirm or correct it in one action. Corrections record what the user chose instead, which closes the loop that makes calibration, the eval set, and bootstrap exit possible at all.

Until this slice, Otto's corrections count is permanently zero and it never leaves bootstrap. After it, Otto can learn what its own confidence is worth.

## Why here

Everything upstream produces dispositions that nobody can see. This is the slice where PRD §4.3's principle — the user can always see what Otto did and why, and correcting it is one step — becomes true rather than designed for.

It also unblocks three slices at once. Merge (7) is confirmed from the queue, transcript correction (8) is a correction affordance, and the dashboard (10) needs the queue as one of its surfaces.

## In scope

**The queue itself**, showing four kinds of entry (PRD §5.4):

- Proposals Otto was not confident enough to apply unattended, which wait for a decision before anything changes.
- Destructive proposals — removals and merges — which wait regardless of confidence. Splits too, if they ever arrive.
- Suspected duplicates, offered as a merge (the entries arrive in Slice 8; the queue's shape accommodates them here).
- **A sampled slice of confident changes** Otto could have applied unattended and deliberately did not. These are **indistinguishable from ordinary entries and are not marked as tests** — the mark exists in the data for calibration, and must not reach the UI, or the user's adjudication is biased by knowing they are being measured.

**Confident, non-destructive changes appear as a record rather than a request.** They applied automatically; the queue shows them so they remain visible and correctable rather than silent.

**Correction, in one action from the queue**, without navigating to the entity (PRD §5.4).

**Corrections record the counterfactual** (ADR-0006), which is the load-bearing detail of this slice. "That's a different Sarah" stores the Sarah the user chose, attached to the Proposal that got it wrong and the Capture behind it — **not a rejection flag**. This is nearly free now and unreconstructable later, and it is what makes the eval set, threshold calibration, and in-context examples possible.

**Corrections append, never edit.** A correction is a compensating event followed by a projection update. Nothing is deleted and history stays intact, which is what makes "why does Otto think this?" answerable months later.

**The correction path issues a Command directly to the executor and does not re-enter the pipeline** (`add.md` §7).

**The discard section** (`triage.md` §7) — collapsed, defaulting to hidden, retained 30 days. A list of what was dropped and from which Capture, with **no affordance to act on it beyond re-capturing**. Making discards actionable would turn the low band into a second review queue, which is what the threshold exists to prevent. "Why didn't Otto pick that up?" has an answer, and the user never has to look.

**Bootstrap status visible in the dashboard** (`triage.md` §4). A user wondering why Otto is asking so many questions deserves the answer that it is still learning what it is worth. PRD §5.4 makes the same point: friction without explanation reads as the product being bad at its job.

**Bootstrap exit.** With corrections now accumulating, the 50-correction threshold becomes reachable and the counter is per provider and model version.

## Not in scope

- **Merge execution.** Slice 8. The queue accommodates a suspected-duplicate entry shape; nothing produces or applies one yet.
- **Transcript correction.** Slice 9. It is a correction of the *input*, not of a Proposal, and needs its own re-extraction path.
- **Split.** Never, in MVP (PRD §7.2, ADR-0009). Test that no split path exists.
- **Threshold calibration tooling** that consumes the corrections. Post-MVP (PRD §7.2) — the data is gathered here, the tuner is not built.
- **Full dashboard chrome.** Slice 11. The queue is a working surface here, not a styled one inside a navigation shell.

## Build order

1. The `proposals` projection surfaced as a queue, ordered and filterable by disposition.
2. Confirm: adjudicating a Proposal issues a Command straight to the executor.
3. Correct: the counterfactual capture — what the user chose instead — attached to the Proposal and Capture.
4. The `corrections` projection and the compensating-event path.
5. Auto-applied changes shown as records, correctable after the fact.
6. The collapsed discard section, read-only.
7. Bootstrap status surfacing and the correction counter per provider and model version.

## Verification

Tier 2 (`qa.md` §7.7) and Tier 1 for the rules it surfaces:

- A correction records **what the user chose instead**, not a boolean rejection, attached to the Proposal that got it wrong and the Capture behind it.
- A correction is a compensating event; nothing is deleted and history stays intact.
- Correcting is one action from the review queue and does not require navigating to the entity.
- **The correction path issues a Command directly to the executor and does not re-enter the pipeline.** Assert the extractor port is not invoked.
- **Sampled proposals are indistinguishable in the UI and marked in the data.** Both halves (`qa.md` §5.5).
- Discards: retrievable, naming their Capture; present at 29 days, absent after 30; **no apply path exposed** (`qa.md` §5.7).
- Bootstrap status is visible, not silent (`qa.md` §5.4).
- **Staleness, end to end** (`qa.md` §10): approve a proposal, assert the UI reflects it immediately, assert it still reflects it after the projection catches up, and assert it does not double-apply or flicker.
- E2E (`qa.md` §10): **review-queue adjudication to applied event** — one of only two E2E paths in the whole plan, justified because the full write path through the UI is itself the thing under test.

## Done when

- A queued Proposal can be confirmed or corrected in one action, and the correction stores the user's chosen answer rather than a rejection.
- Auto-applied changes are visible in the queue and correctable.
- Sampled entries are indistinguishable from ordinary ones in the UI and identifiable in the data.
- The discard section lists dropped proposals with no way to act on them.
- Accumulating 50 corrections for a model exits bootstrap for that model.
