# The field schema is closed and typed; relations are a closed vocabulary; discards stay visible

---
Status: accepted
---

ADR-0010 made fields the model and said adding a kind of claim is a schema change. It did not enumerate the fields, which left the extractor's output schema, the differ's cardinality rules, and every entity view unbuildable. The full model is in [`schema.md`](../schema.md); this ADR records the three decisions inside it that are choices rather than enumeration, plus two smaller rules that belong with them.

**The relation vocabulary is closed.** ADR-0010 closed the predicate-vocabulary question for fields, but Relations reopen exactly the same problem one level up: an open set lets Extraction invent `works_on`, `working_on`, and `involved_with` for one idea and fragments the graph. So relation names are a fixed, typed, small set — seven names, each declared with the entity types it connects — and adding one is a schema change. This is the same honest cost ADR-0010 accepted for fields, applied consistently rather than abandoned at the edge.

`relates_to` is the deliberate catch-all in that set, and it is the one to watch: if it comes to dominate the graph, the vocabulary is too small and needs a named addition. That is a signal the schema surfaces as data rather than a flaw it hides.

**Enums are closed with an `other` member, and unstructured facts go to `notes`.** Every enum has an escape value, and anything true that no typed field can hold becomes a `notes` entry rather than being discarded. Without this, the absence of a field means the loss of a fact — a schema that cannot express "Sarah is allergic to shellfish" should still not throw the sentence away. The cost is that `notes` is unqueryable, which makes its growth rate the schema's own health metric: a fact repeatedly reinvented in `notes` is a field the schema is missing. Neither rule lets Extraction invent a field name; the output schema is generated from the field tables, so unknown fields are rejected at parse time.

**Some fields never auto-apply, independent of Confidence.** `name` on any entity and the `became` relation carry a review floor, because renaming is identity-adjacent and promotion is closer to merge than to an ordinary edge. This is the field-level extension of ADR-0007's application policy and lives with it in `domain/policies/`, for the reason ADR-0007 gives: a rule that never reads the Confidence number does not belong next to the thresholds.

**Dates are resolved by Extraction, with precision recorded.** "Tuesday" becomes an absolute date, and Ingestion may not do it — ADD §5.1 uses date-noticing as its example of what Ingestion must not do. Each date carries a precision marker (`exact` through `year`, plus `relative_unresolved`) so that "sometime next quarter" and "on the 4th" do not become indistinguishable timestamps. `relative_unresolved` keeps the phrase, stores no timestamp, and is excluded from anything time-ordered — the honest representation of "when the contract lands," which is a real thing a note says and is not a date.

**Discarded Proposals stay visible.** Triage has three outcomes and PRD §5.4 described two, which left `discard` as a silent drop and put it in tension with the principle that the user can always see what Otto did (PRD §4.3). Discards are recorded and shown in a collapsed section of the Review queue, hidden by default, retained 30 days, with no affordance to act on them beyond re-capturing. Making them actionable would turn the low band into a second Review queue, which is what the threshold exists to prevent.

**Corrected transcripts are events, not edits.** Captures store the raw transcript and optionally a user-corrected text; correcting one appends `CaptureTranscriptCorrected` and never overwrites, preserving the immutability rule (ADR-0005) while making a mis-heard name fixable in one step. Typed Captures are not editable — they were not misheard, and editing them would be note-editing, which PRD §6 excludes.

## Considered Options

- **Open relation vocabulary, LLM-proposed then triaged** — rejected: it is the ADR-0004 predicate problem returning under a different name, and triage cannot repair a fragmented vocabulary after the fact.
- **No `notes` escape hatch, strict schema only** — rejected: silently discarding true statements is worse than storing them unqueryably.
- **A generic `attributes` key-value bag** — rejected: that is the Assertion model with worse ergonomics, and ADR-0010 reversed it deliberately.
- **Silent discards** — rejected: cheap to surface, and the trust cost of a mysterious omission is exactly the failure mode PRD §8 names.
- **Mutable transcripts** — rejected: weakens the immutability rule for a case an event handles cleanly.

## Consequences

- **Adding a field or a relation name is a code change**, forever. Accepted explicitly in ADR-0010 and restated here because it applies to the graph as well as to entities.
- `notes` volume must be monitored, since it is where schema pressure accumulates and it is the one place growth means something rather than nothing.
- Date precision propagates to the UI: a `quarter`-precision date must render as "Q3" and never as a specific day, or the model's honesty is discarded at the last step.
- Correcting a transcript re-runs the pipeline for that Capture — the one case where re-extraction is automatic (ADR-0011), because the user has explicitly said the input was wrong.
