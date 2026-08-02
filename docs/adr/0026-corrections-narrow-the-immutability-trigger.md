# A correction narrows the immutability trigger rather than dropping it, the replace path is closed, and the automatic re-run stops at extraction

---
Status: accepted
---

[ADR-0005](./0005-event-sourcing-with-rebuildable-projections.md) made Captures immutable and [ADR-0014](./0014-typed-fields-closed-relations-visible-discards.md) settled that a corrected transcript is an event rather than an edit. Neither says how `captures.corrected_text` — a column on a table whose triggers refuse UPDATE — is actually written. Slice 9 is the first thing to write it, and the answer is not obvious enough to leave to the code.

**The UPDATE trigger is narrowed to one transition rather than dropped.** `captures_are_immutable` now carries a `WHEN` clause that lets exactly one statement through: `corrected_text` moving from `NULL` to a value, with every other column unchanged. Everything else is refused as before — a second correction, clearing a correction back to `NULL`, and any write to `raw_text`, `capture_id`, `source`, `transcription_model`, `source_timestamp`, `content_hash`, or `ingested_at`.

The alternative is a separate `capture_corrections` table joined on read, which keeps the trigger untouched and was the first design tried. It was rejected because it makes `corrected_text` a column that exists and is never written — Slice 2 declared it deliberately so that Slice 9 would be an append rather than a second reshape (`docs/slices/02-capture.md`), and adding a table beside it would strand that column while paying the reshape cost anyway. It also puts a join in front of every read of a Capture's current text, including the FTS index build, which already reads `COALESCE(corrected_text, raw_text)` from the row.

What makes the narrowing safe rather than a weakening is that the permitted write is **write-once and identity-preserving**. `content_hash` covers `raw_text` and both are refused, so no correction can re-key a Capture or change what any existing `capture_id` was derived from. The event remains what is true; the column is the materialisation of it, which is why `SqliteCaptureStore.recordCorrection` reads the row back rather than trusting its own write.

The guard is written as **what stays refused** rather than as what is allowed, because the two fail in opposite directions. A permit-list silently widens the moment a column is added — the new column is not in the list, so writing it is allowed. The refuse-list version leaves a new column uncovered too, which is why the column set is pinned by a test that fails when one is added without being named.

**`recursive_triggers` is on, because `INSERT OR REPLACE` was a hole in both truth tables.** SQLite implements a replace as a delete followed by an insert, and by default runs neither the UPDATE nor the DELETE trigger on that path. So `events` and `captures` were overwritable, since Slice 0, by a statement their triggers appeared to refuse — and a correction path needing to write a column against an UPDATE-refusing table is precisely what reaches for that statement. The pragma makes the DELETE trigger fire, which refuses the replace.

This is worth stating as a decision rather than a bug fix because it changes what `qa.md` §4.1's guarantee actually rested on. The triggers were necessary and not sufficient; the connection configuration is load-bearing, and a database opened without `openDatabase` does not have the property the schema appears to declare. The test builds its database through `openDatabase` for that reason.

**The automatic re-run stops at extraction, because there is nothing further to drive.** `runtime.md` §5 says correcting a transcript "re-runs the pipeline for that Capture," and what ships re-runs extraction only. Resolution, the differ, and triage are not invoked — not by choice here, but because **no pipeline driver exists**: triage has been wired and undriven since Slice 5, and nothing in Otto orchestrates the stages end to end for any Capture, corrected or not.

So the correction path is complete up to the boundary the system currently has, and it stops there rather than growing a second orchestrator that would have to be reconciled with the first when one arrives. The consequence is that `runtime.md` §3's "a re-extracted Proposal matching current state closes silently" is *satisfied vacuously* rather than implemented: under the same model the derived ids collide, nothing new is proposed, and nothing reaches a queue — but no Proposal is adjudicated and closed, because `repropose.ts`'s `no_change` closure runs from the differ and needs the driver. The code says this where a reader would otherwise assume the rule is enforced.

## Considered Options

- **A separate `capture_corrections` table** — rejected: strands the column Slice 2 declared for this purpose, and puts a join in front of every read of a Capture's current text.
- **Dropping the UPDATE trigger on `captures`** — rejected: it removes the guarantee for every column to permit a write to one, and `qa.md` §4.1 wants the database to refuse rather than the application to decline.
- **`INSERT OR REPLACE` as the write path** — rejected, and then actively closed. It works only because it evades the triggers, which makes the mechanism that permits the correction the same one that would permit tampering.
- **A permit-list `WHEN` clause** — rejected: it widens silently when a column is added, where the refuse-list version at worst leaves a gap a test can pin.

## Consequences

- **A correction cannot be corrected.** The trigger refuses a second write to `corrected_text`, so a user who mis-types their correction has no path to fix it. This is deliberate for MVP — the log would carry a second `CaptureTranscriptCorrected` with no column to land in, which is a divergence between event and materialisation rather than an edit. A slice that wants re-correction changes the column to hold the latest fold of the correction events, not the trigger.
- **Adding a column to `captures` requires naming it in `CORRECTION_IS_THE_EXCEPTION`.** A column left out is one a correction statement could write alongside the corrected text. The test enumerating the columns is what catches it.
- **Every connection must go through `openDatabase`.** The immutability guarantee is not fully declared in `CREATE_SCHEMA`, and a caller constructing a connection by hand gets a database that permits replacement.
- **"The entity Otto derived updates" is not yet true end to end.** The corrected text is what extraction reads and what search returns, but no entity is re-derived from it, because the stages past extraction have no driver. The slice that builds one inherits the correction path as a caller rather than having to retrofit it.
