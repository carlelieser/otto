# Slice 2 — Extraction

> Depends on: Slice 1. Blocks: Slice 3.
> Sources: [`add.md`](../add.md) §5.2, §9; [`schema.md`](../schema.md) §1, §7, §8; [`runtime.md`](../runtime.md) §2, §3; [`qa.md`](../qa.md) §6; ADR-0008, ADR-0013, ADR-0016.
>
> **This slice carries the one open gate in the project.** See "The measurement" below.

## What it closes

A stored Capture is read by a model and becomes structured output: Mentions of entities as they appeared, and the field values claimed about them, with dates resolved and precision-marked. Nothing is resolved to a real entity and nothing is written to knowledge — the output is structure, not yet belief.

## Why here

Extraction reads *nothing but the text* (`add.md` §5.2). That constraint is not an implementation detail — it is what makes extraction testable against a fixed corpus with fixed expected output, and therefore what makes the eval set possible at all. A stage that read current state would have correct output that changes as the database does.

That property also means extraction can be built and measured before entities exist, which is why it comes before resolution rather than with it. And it is where the eval set starts, which `qa.md` §12 puts at step 6 with the instruction to start hand-built rather than wait for organic data.

## The measurement

**The local-extraction quality measurement runs here, and it is this slice's exit condition.** PRD §9 and ADR-0013 list it as gating implementation; `stack.md` §7 and `runtime.md` §2 both name schema-constrained extraction from a 7–8B local model as the single most likely technical assumption in Otto to be wrong. Grammar-constrained decoding guarantees *parseable* output, not *correct* output.

The floor, stated as a pass condition (`runtime.md` §2, `qa.md` §6.3): **the local path produces a usable knowledge base with more review friction, not a corrupted one.** Operationally:

- Schema violation rate at or near zero. Grammar constraints should guarantee this; if they do not, the constraint is misconfigured.
- Field-value accuracy worse than cloud by a *measured* margin rather than an assumed one.
- **More proposals landing in review, not more wrong proposals auto-applying.** A local run whose auto-apply rate matches cloud's is a red flag, not a success.

If the floor is not cleared, the response is a larger minimum local model — never looser thresholds, and never a restored cloud default to hide it (ADR-0016). The decomposition fallback is available first: several narrower prompts, mentions then fields per mention, trading latency for reliability. Latency is affordable because the pipeline is asynchronous and nobody is waiting.

## In scope

**The `Extractor` port.** A Capture's text in, structured Mentions and values out. ADR-0008's test holds: if the signature mentions `temperature`, `max_tokens`, or `messages[]`, it is a vendor-shaped port wearing a generic name.

**The local adapter, as the default path.** Qwen-class 7–8B instruct, GBNF-constrained, via LMStudio or Ollama (ADR-0016). This is what Otto runs with nothing configured, and the suite's baseline run has no provider credentials present at all.

**The two cloud adapters, opt-in and per port** — Claude (Sonnet tier) and OpenAI. Configurable per port rather than globally. A shared prompt template in `infrastructure/llm/shared/`, with per-adapter differences confined to *how* structured output is requested: tool use, JSON mode, or grammar constraints (`add.md` §9). Three providers means three copies of the prompt drifting apart; the shared template is the mitigation for a cost ADR-0008 accepts rather than eliminates.

**The output schema, generated from `schema.md`** — not hand-written beside it. This is what makes "the model cannot invent a field name" structural rather than aspirational: an unknown field fails parsing before it reaches the differ (`schema.md` §7).

**Date resolution with precision markers** (`schema.md` §8). The Capture timestamp is given to the extractor as context and dates come back absolute, each with `exact`, `day`, `month`, `quarter`, `year`, or `relative_unresolved`. "Sometime next quarter" and "on the 4th" must not become indistinguishable timestamps. `relative_unresolved` stores no timestamp, keeps the phrase, and is excluded from anything time-ordered.

**`p(extraction)` reported and kept separate** from resolution's confidence throughout (`triage.md` §1). It is the model's self-report and has no scorer behind it, which is why Slice 4 treats it as a floor rather than a probability.

**Provider and model version recorded on everything produced**, and folded into `proposal_id` per `runtime.md` §3. Schema-constrained output at temperature 0.

**The eval set, hand-built.** `qa.md` §6.2 lists the cases the corpus must contain — they are the cases the design says are hard, not representative notes. It starts hand-built and grows from real corrections later (ADR-0006 sets ~50 as the minimum for a regression suite).

**Pipeline resumability at this stage.** Each stage records its output against the Capture before the next begins (`add.md` §4), so a crash mid-extraction leaves a Capture with no Proposals that the worker picks up on restart, and a crash after extraction does not re-bill the LLM call.

## Not in scope

- **Resolution.** Slice 3. Extraction produces Mentions; which entity a Mention refers to is a different question and a different confidence.
- **The differ and Commands.** Slice 3. The model never emits a Command — that is where hallucination is structurally prevented.
- **Triage and thresholds.** Slice 4. Extraction reports a number; nothing acts on it yet.
- **Re-extraction as a user action.** The id derivation supporting it ships here; the scoped manual re-extraction tool is Slice 8's neighbour and can follow it.
- **Embeddings.** Slice 3, where candidate generation needs them.

## Build order

1. `Extractor` port and the in-memory adapter, so the pipeline runs with no model at all. This is the case where a second adapter *is* load-bearing (`add.md` §9): there is no offline mode for an LLM, so without a stub returning canned output nothing downstream of extraction is testable.
2. Output schema generation from `schema.md`'s tables, with unknown-field rejection at parse time.
3. The local adapter — GBNF constraints against the generated schema.
4. Date resolution and `date_precision`.
5. The eval corpus, hand-built per `qa.md` §6.2.
6. The two cloud adapters over the shared prompt template.
7. **The measurement.** Local against cloud on the same corpus, per `qa.md` §6.1's metric table.

## Verification

Tier 3 (`qa.md` §6) — measured, not asserted. `qa.md` §2 is explicit that any test asserting an exact extraction string will fail for reasons unrelated to Otto being broken.

Metrics, per provider and model version: mention recall, mention precision, field-value accuracy, schema violation rate (zero-tolerance), date resolution accuracy, `date_precision` correctness.

Deterministic tests that do belong here:

- Unknown field names are rejected at parse time. The output schema is generated from `schema.md`, so this should be structurally impossible — test that it is (`qa.md` §7.2).
- **Derived fields can never appear in a Proposal.** If the extractor emits `salience` or `last_contact_at`, it is dropped and **the drop is logged as a schema violation, not accepted quietly** (`schema.md` §1). Both halves tested.
- Enum values outside a closed set produce `other` plus a `notes` entry (`schema.md` §7).
- Notes containing no extractable entity produce no spurious Proposal — a valid outcome.
- **The full pipeline runs green with no provider configured** (`qa.md` §6.3). The unconfigured state is the primary configuration, not an edge case.
- Removing a previously-configured provider leaves Otto functional rather than stalled.
- Resumability: a crash after extraction resumes at the next stage rather than re-invoking the extractor.
- Capture stays responsive while a long local extraction runs (`qa.md` §8) — the Slice 1 test, now with real load behind it.

## Done when

- A Capture produces Mentions and field values through the local path with no credentials configured anywhere.
- The eval corpus runs in CI on every commit against the in-memory adapters, and against real models on demand.
- **The §6.3 floor is cleared by the local path, with the margin against cloud recorded as a number.** If it is not cleared, the minimum local model size is raised and the measurement re-run — this slice does not exit by lowering the bar.
- Schema violation rate is at or near zero on the local path.
