# Ports are named after tasks, not vendors

---
Status: accepted
---

Otto defines `Extractor` and `Adjudicator` ports — named after what the domain needs — rather than a single generic `LlmClient`. A chat-completion port is the *vendor's* abstraction, not ours, and adopting it pushes prompt construction and response parsing up into `inference/`, so that swapping a provider means editing inference logic. Our two LLM uses have genuinely different shapes anyway: extraction needs schema-constrained structured output over a whole note; adjudication needs a small pick-one-of-N with a score. Each adapter owns its prompt, schema, parsing, and vendor call, so adding a provider is one new file implementing one interface.

The interfaces live in `ports/`, never beside the adapters in `infrastructure/llm/`. That placement *is* the dependency inversion: the consumer owns the contract and vendors conform to it. Putting the interface next to the adapters inverts the inversion, and the abstraction starts tracking whatever a vendor's SDK happens to expose. **The test:** if a port signature mentions `temperature`, `max_tokens`, or `messages[]`, it is a vendor-shaped port wearing a generic name.

Otto expects multiple providers from the outset — Anthropic, OpenAI, and local runtimes such as LMStudio — since a private, local-first system must degrade to fully local inference.

## Consequences

- Task-shaped ports mean **the prompt lives per adapter**, so three providers means three copies of the extraction prompt drifting apart. Mitigation: a shared prompt template in `infrastructure/llm/shared/`, with per-adapter differences confined to how structured output is requested — tool use vs JSON mode vs grammar constraints, which genuinely do differ across these three.
- **Provenance must record provider and model version on every proposal**, or ADR-0006's eval set measures an average across models.
- **Thresholds are keyed by model and version.** A confidence of 0.8 from a local Llama is not the same number as 0.8 from Claude. Easy now, genuinely painful to retrofit once months of correction data have accumulated under a single unlabelled threshold.
