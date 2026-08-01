# The inference layer cannot write; the executor is the only writer

---
Status: accepted
---

Everything probabilistic — extraction, candidate generation, scoring, LLM adjudication, and the differ that produces proposed commands — lives in `inference/`, and **nothing in that directory performs a write**. It reads current state and emits proposals. A single executor in `application/apply-command.ts` is the only component in the system permitted to write. This is the highest-value folder boundary in the tree because it encodes a rule that cannot be expressed any other way: with the boundary in place, a stray write from the LLM path is visible in a diff, rather than a behaviour discovered in production after it has corrupted the user's knowledge base.

The same reasoning applies to `infrastructure/`, which nothing may import except the composition root. Both rules are enforced with a lint rule from the start rather than by discipline, because these are precisely the boundaries that erode under time pressure and their erosion is silent.

## Consequences

- Triage lives in `inference/calibration/` (ADR-0007) and therefore also cannot write — it only computes a disposition, which the application layer then acts on. This is consistent, but means the read of "who decides" and "who acts" is split across two layers.
- Two seams justify the structure's overhead: **capture → inference** (raw input becomes semantic reasoning) and **inference → application** (uncertainty becomes commitment). The rest of the layering is standard and would be defensible either way.
