# Corrections record the counterfactual; feedback is for calibration, not fine-tuning

---
Status: accepted
---

When the user adjudicates a proposal, Otto records **what the user did instead** — the corrected label, attached to the original proposal and capture — not a boolean approved/rejected. A rejection alone says the answer was wrong but not what right looked like, and every downstream use of this data needs the latter. This is a schema decision that is cheap now and expensive after a year of thumbs-down data that cannot be learned from.

The data is explicitly **not** for fine-tuning: at single-user volume the corpus will never be large enough, and tuning would freeze Otto to one model at exactly the moment base models keep improving. It exists for, in descending order of value: an **eval set** (each correction is an input/correct-output pair; ~50 makes a regression suite, without which prompt changes are vibes and the pipeline rots silently), **threshold calibration** (of proposals scoring 0.85, how many were right — self-reported LLM confidence is a token distribution, not a probability, and cannot be trusted until checked against outcomes), **in-context examples** (retrieving relevant past corrections into the prompt), and **plain state** ("Atlas is a project, not a person" is simply a fact for the database).

## Consequences

- **Feedback is biased toward the review lane.** Auto-applied proposals that were wrong mostly never get corrected because nobody is looking, so the correction log systematically over-represents the middle confidence band and says almost nothing about whether the auto-apply threshold is too loose. The mitigation is to deliberately sample a slice of high-confidence auto-applies into review anyway, trading a little user friction for an unbiased estimate of our own error rate. This must be built in from the start — it cannot be reconstructed retroactively.
- Every proposal must carry provider and model version in its provenance (ADR-0008), or the eval set measures an average across models and calibration is meaningless.
