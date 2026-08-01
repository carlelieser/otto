# Slice 8 — Transcript correction

> Depends on: Slice 6. Independent of Slices 7 and 9.
> Sources: [`prd.md`](../prd.md) §5.5, §6; [`add.md`](../add.md) §5.1; [`runtime.md`](../runtime.md) §3, §5; [`qa.md`](../qa.md) §7.6; ADR-0014.

## What it closes

The user fixes a misheard word in a voice transcript in one step, and Otto re-reads the note and updates what it derived from it. The original transcript is kept; nothing is overwritten.

Small slice, specific job: voice capture mishears names, and a mishearing becomes a wrong entity. Without this, a mis-transcribed name is a permanent wrong entity.

## Why here

It needs the review queue's correction affordance (Slice 6) and it needs something derived to update, which means the projections (Slice 5). It is independent of merge and briefs and can be built in any order among them.

It is also the smallest slice that touches the immutability rule, which is why it is worth isolating rather than folding into Slice 6: **it must not weaken that rule**, and the way it avoids doing so is precise enough to deserve its own verification.

## In scope

**Both texts on the Capture.** The raw transcript and, optionally, a user-corrected text. Both immutable once written.

**`CaptureTranscriptCorrected` as an event** carrying the corrected text. The original is never overwritten (`runtime.md` §5, ADR-0014). This keeps the immutability rule intact exactly as stated — the correction is an event like any other — while making a misheard name fixable.

**Extraction reads the corrected text where one exists.**

**Automatic re-extraction for that Capture.** This is **the one case where re-extraction is automatic** (`runtime.md` §3, §5), because the user has explicitly said the input was wrong. Everywhere else, re-extraction is manual and scoped: silently re-processing history when a model changes would flood the review queue and re-litigate settled knowledge.

**Re-extracted Proposals that match current state close silently** (`runtime.md` §3). Most re-extraction confirms what Otto already believes; only the differences are worth the user's attention.

**Provenance names the corrected text** as what produced the fact, after correction.

**Typed Captures are not editable** (PRD §5.5, §6). They were not misheard, and editing them would make Otto a document editor. The affordance must be *absent*, not disabled.

## Not in scope

- **General note editing.** Explicitly excluded by PRD §6. This corrects what Otto *heard*, not what the user *meant* — the PRD is specific that this is not an exception to the no-document-editor rule.
- **Manual scoped re-extraction over a range of Captures** (`runtime.md` §3). A neighbouring tool for recovering from a known-bad extraction period, sharing this slice's machinery. Worth building here if cheap, but it is not what this slice closes.
- **Re-transcription with a better model.** `large-v3` is an optional download (`runtime.md` §2); swapping models and re-running audio is not specified and does not ship.

## Build order

1. The `CaptureTranscriptCorrected` event. The `corrected_text` column already exists from Slice 1, holding `NULL` — this slice is the first thing to write it, which is what makes the change an append rather than a migration against a table whose triggers refuse UPDATE.
2. The correction affordance on a voice Capture, one step.
3. Extraction reading corrected text in preference to raw.
4. Automatic re-run of the pipeline for the corrected Capture.
5. Silent closure of re-extracted Proposals matching current state.

## Verification

Tier 2 (`qa.md` §7.6):

- Correcting a transcript appends `CaptureTranscriptCorrected`; **the original is never overwritten and both texts remain readable.**
- The corrected text becomes what Extraction reads.
- Correction re-runs the pipeline for that Capture — the one case where re-extraction is automatic.
- Provenance after correction names the corrected text as what produced the fact.
- **Typed Captures are not editable.** Test the *absence* of the affordance.
- A re-extracted Proposal matching current state closes silently rather than appearing in the queue (`qa.md` §4.3).
- Re-extraction under the same model produces identical proposal ids; under a different model version, new ids arriving as ordinary Proposals subject to ordinary triage (`qa.md` §4.3). **A test asserting only the first would pass on an implementation that hashed away the model version**, which is the bug `runtime.md` §3 is written to prevent.
- `captures` still rejects UPDATE and DELETE at the SQLite level — the Slice 1 Tier 0 test, re-verified now that a correction path exists.

## Done when

- A misheard name in a voice note is fixable in one step, and the entity Otto derived updates.
- Both the raw and corrected transcripts are readable, and the raw one is provably unmodified.
- Typed notes expose no edit affordance.
- Re-extraction that confirms existing belief produces no queue entries.
