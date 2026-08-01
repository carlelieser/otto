# The LLM's job ends at "this mention refers to entity #4172"; triage splits across layers

---
Status: accepted
---

Otto's shape is **retrieval → constrained generation → deterministic application**. The LLM is a component inside two stages, not the pipeline itself, and the boundaries are drawn deliberately:

- **Extraction: LLM.** Unstructured text to structured mentions is exactly the job. Schema-constrained output, temperature 0, model version pinned into the record so a proposal can be reproduced when debugging it months later.
- **Entity resolution: mostly not LLM.** Three steps — deterministic **candidate generation** (exact alias hits, fuzzy/trigram match, embedding nearest-neighbours), then **scoring** on features we control (name similarity, historical co-occurrence with other entities in the same note, recency, type agreement), then **LLM adjudication** over the top three or four candidates, for genuinely ambiguous cases only. Retrieval is required regardless, since the model cannot hold the entity graph in context.
- **Proposed commands: no LLM.** A deterministic diff between resolved state and current state. Letting the model emit commands directly yields hallucinated field names, invented ids, and nothing to typecheck.

The **confidence number comes from the scorer, not from the model's self-report**, and it is not one number: `p(extraction correct)` and `p(resolution correct)` stay separate and are combined explicitly by triage, because the failure modes need different handling — a bad extraction invents a fact (pollution), a bad resolution attaches a real fact to the wrong entity (recoverable by relinking).

**Triage is split across both layers**, because the word conflates two questions with different survival properties under ADR-0002's "does this concept survive deleting the software?" test:

- *"Is this proposal likely enough to be correct?"* — a question about how well our LLM pipeline performs. Delete Otto and the question disappears with it. This is **calibration**, and it lives in `inference/calibration/` along with the thresholds, which are keyed by model and version (ADR-0008).
- *"What kinds of change may happen to knowledge without a human looking?"* — a question about the user's tolerance for damage to what they know. It stays true whether the proposed change came from an LLM, a regex, or a human typing directly. This is **domain**, and it lives in `domain/policies/application-policy.ts`.

The diagnostic that settles it: the `remove` rule does not reference confidence at all. It is *"never, at any confidence"* — a rule with no threshold in it. A rule that never reads the number it is supposedly about belongs to a different concern than the numbers do.

Control flows one way. Calibration computes a proposed disposition from confidence, then asks the domain policy whether a change of that kind is permitted to apply unattended; the domain policy may only ever downgrade `auto_apply` to `needs_review`, never upgrade. Both halves stay pure functions with zero I/O, and `domain/` still never learns the word "confidence" — the application policy is asked about a *kind of change*, not a score.

## Considered Options

- **All of triage in `inference/calibration/`** — keeps every disposition decision in one file and `domain/` free of pipeline concepts. Rejected: it files the system's most domain-flavoured rule ("a confident-but-wrong delete destroys trust") next to numeric thresholds, where a reader looking for rules about knowledge will not find it, and where it looks tunable when it is not.
- **All of triage in `domain/policies/`** — one readable place for all rules. Rejected: drags `Confidence` into `domain/`, and confidence is exactly the example ADR-0002 uses of a concept that does *not* survive deleting the software.

## Consequences

- **`remove`, `merge`, and `split` never auto-apply, at any confidence.** Create and update are additive and reversible in practice; the other three are destructive to identity and a confident-but-wrong one destroys trust. All three rules sit in `domain/policies/`, with the other rules about what may happen to knowledge.
- Answering "what will happen to this specific proposal?" means reading two files rather than one. Accepted deliberately: the alternative is one file that answers two unrelated questions, and the coupling would show up the first time a threshold change required reasoning about blast radius.
- The application policy is the natural home for later rules of the same kind — bulk changes above some size needing confirmation, say — none of which are about confidence either.
- Nothing about a change being unattended-forbidden stops Otto from *proposing* it. Proposal and execution are separate stages; the policy governs disposition only. Otto proposes merges, splits, and removals freely, and they wait in the review queue.
