# Otto — pre-spec notes

> **Historical. Superseded in full — do not use as a reference.**
>
> This was the working scratchpad before the specifications existed. Everything in it has either been decided and written up properly, or has been reversed. It is kept because the reasoning is sometimes useful for understanding *why* a decision went the way it did, and for nothing else.
>
> **Known to be wrong below:** it presents ADR-0004's Assertion model as decided (reversed by [ADR-0010](../adr/0010-entities-carry-fields-assertions-reversed.md) — entities carry typed fields, there is no Assertion), it describes `domain/knowledge/` as containing an assertion type, and its "Not yet mapped" section lists as open a set of questions that are now all answered.
>
> **Current sources of truth:** [`prd.md`](../prd.md) for product, [`add.md`](../add.md) for architecture, [`schema.md`](../schema.md) for the field model, [`triage.md`](../triage.md) for confidence and dispositions, [`runtime.md`](../runtime.md) for the process model and local inference, [`salience.md`](../salience.md) for surfacing, [`docs/adr/`](../adr/) for settled decisions, and [`CONTEXT.md`](../../CONTEXT.md) for vocabulary.

- Otto is a private, local, sophisticated cross-platform note-taking system.
- Event-driven clean architecture (hexagonal / ports & adapters + tactical DDD vocabulary).
- Stack: Tauri, Svelte, TypeScript, SQLite, DrizzleORM, AI SDK, ShadCN
- Entities: Person, Project, Idea, Event, Task
- Review queue
- Simple, minimalist UI using component library. basic shell with sidebar for navigating between notes, people, projects, ideas, events, and tasks. main content is simple listing layout with basic search, sorting, filtering, and list/grid view.

## Basic flow:

1. User takes note.
2. System "ingests" it, creating records or updating existing ones.
3. User can approve or deny proposals. Proposals with high confidence automatically approved.

---

## Domain

- The domain is **personal knowledge and its revision over time** — not note-taking. Notes are input; the knowledge structure (people, projects, ideas, and how my understanding of them changes) is the subject matter.
- Test for "is this domain?": does the concept survive deleting the software? "A person can be mentioned in a note" survives. "Confidence score" does not — that's application machinery.
- Because the domain is *revision*, change/ambiguity/provenance are first-class, not error handling. Corrections are revisions of belief, i.e. domain events.
- **Strategic DDD: no.** Bounded contexts, context maps, ubiquitous language negotiation solve org problems; solo project.
- **Tactical DDD: partially.** Aggregate (unit of consistency, what gets version-checked), entity vs value object, domain events, policies. Applies *below* triage — DDD has no vocabulary for uncertainty, so it doesn't fit the inference half.
- **DECIDED (ADR-0004): `Assertion` is first-class.** "Sarah works at Acme" is a claim from a note at a time, which can become false without ever having been wrong. Person/Project/Idea/Event/Task are thin (identity + aliases); the assertion log is rich. Bitemporal: when it was true, and separately when we learned it.
- Concepts the knowledge framing hands us that CRUD doesn't: **merge / split** (two entities turn out to be one, or one turns out to be two — normal operation, semantics in ADR-0009), **assertion vs entity**, **salience** (what deserves resurfacing; forgetting as a feature).
- Don't take "mind" literally — no `Hippocampus` module. The metaphor is generative for the *shape* of the model, misleading for the *mechanics*.

## Pipeline (write path)

**capture → ingest → extract → resolve → propose → triage → apply → (surface / feedback)**

1. **Capture** — text, voice, email, whatever. Ingress adapters normalize to one immutable capture record with a stable id. That record is source of truth.
2. **Ingestion** — normalization only, no semantic reasoning: transcription, email quoting/signature stripping, idempotency key, timestamp, attachments, persist. Named module now, possibly a separate process later; write it as if it were already separate (communicates with extraction only through the persisted capture record).
3. **Extraction** — text → structured mentions/claims. Pure function of the note, **no DB access**. This is what makes it testable against a fixed corpus.
4. **Entity resolution** — is *this* Sarah a Sarah we already have? The only stage that reads current state.
5. **Proposal (differ)** — resolved references + extracted attributes vs current state → commands. Deterministic diff.
6. **Triage policy** — pure function, proposal → disposition (`auto_apply | needs_review | discard`). Zero I/O.
7. **Executor** — the only component permitted to write. Everything else proposes.

### Commands vs events

- **Command** = intent. Imperative verb + target (`CreatePerson`, `UpdateProject`). Rejectable. Carries confidence.
- **Event** = fact. Past tense (`PersonCreated`). Immutable, never rejected, never deleted, no confidence field.
- Smell: a confidence score on anything past-tense means two concepts got merged.

### What is and isn't LLM

- **Extraction: LLM.** Schema-constrained output, temperature 0, model version pinned into the record (otherwise a proposal can't be reproduced for debugging later).
- **Entity resolution: mostly not LLM.** Three steps:
  1. **Candidate generation (blocking)** — narrow the entity table to a handful. Deterministic and cheap: exact alias hits, fuzzy/trigram name match, embedding NN. Required regardless, since the model can't hold the whole graph in context.
  2. **Scoring** — rank candidates on features we control: name similarity, historical co-occurrence with other entities in the same note, recency, type agreement. **This is where the confidence number should come from.**
  3. **Adjudication** — LLM gets note + top 3–4 candidates, picks one or none. Ambiguous cases only.
- **Proposed commands: no LLM.** Deterministic diff. Letting the model emit commands directly gives hallucinated field names, invented ids, nothing to typecheck. The model's job ends at "this mention refers to entity #4172."
- Overall shape: **retrieval → constrained generation → deterministic application.** The LLM is a component inside two stages, not the pipeline.

### Confidence

- Not one number. `p(extraction correct)` and `p(resolution correct)` are separate; triage combines them explicitly. Different failure modes: bad extraction = invented a fact (pollution); bad resolution = real fact attached to the wrong person (recoverable by relinking).
- LLM self-reported confidence is a token distribution, not a probability. Don't trust it until it's checked against outcomes.
- **Thresholds are per-model.** 0.8 from a local model ≠ 0.8 from Claude. Key `thresholds` by model+version — cheap now, painful to retrofit after months of correction data under one unlabelled threshold.
- **`remove` never auto-applies, at any confidence.** Not a threshold — a judgment about blast radius. Create/update are additive and reversible; a confident-but-wrong remove destroys trust. Lives in `domain/policies/application-policy.ts`, not with the thresholds (ADR-0007): a rule that never reads the confidence number doesn't belong next to the numbers.

## State model

- **Source of truth**: capture records + event log. **Derived**: the entity tables, search index, embeddings, backlinks, counts — all **projections**, must be rebuildable from source alone.
- Consequences that fall out for free: embedding model changes → rebuild the projection; losing the vector index is survivable; a write doesn't need to update six things atomically (write, then reindex asynchronously).
- **Correction = append a compensating event + rebuild.** History is never mutated. Time-travel for free.
- **DECIDED (ADR-0005): full event sourcing.** The log is the sole source of truth; entity tables are projections. Rejected the lighter mutable-tables + `changes` table option because ADR-0004 makes the log the model rather than an audit artifact beside it. Accepted costs: event versioning discipline, replay growth (snapshotting undesigned), read-side lag.
- **Provenance** on every entity (ideally every field): pointer back to capture, proposal, model + version, confidence, whether a human confirmed. The chain capture → proposal → event → current state is the **lineage**.

### Two things not yet handled

- **Staleness** — a proposal computed at T may apply at T+3 days after sitting in review; the target may have changed. Fix: **optimistic concurrency** — stamp the proposal with the target aggregate's version, check at apply time, re-propose on mismatch.
- **Idempotency** — retried capture or double-delivered email creates Sarah twice. Stable capture id → derived proposal ids → apply is idempotent on that key.

## Feedback loop

- Not fine-tuning. Wrong tool: no volume at single-user scale, and it freezes us to one model while base models improve.
- What corrections actually buy, in order of value:
  1. **Eval set** — each correction is an (input, correct output) pair. ~50 of them is a regression suite. Without it, prompt changes are vibes and the pipeline rots silently.
  2. **Threshold calibration** — of proposals scoring 0.85, how many were right? Highest-leverage measurement.
  3. **In-context examples** — retrieve relevant past corrections into the prompt. Most of what fine-tuning gives, instantly updated.
  4. **Plain state** — "Atlas is a project, not a person" is just a fact for the DB.
- **Record the counterfactual, not a boolean.** Rejection says the answer was wrong, not what right looked like. If the user rejects `CreatePerson(Sarah)` and links to an existing Sarah, capture that as the corrected label attached to the original proposal + capture. Schema decision, cheap now.
- **Sampling bias**: auto-applied wrong proposals mostly never get corrected because nobody's looking, so the correction log over-represents the review band and says nothing about whether auto-apply is too loose. Fix: deliberately sample a slice of high-confidence auto-applies into review anyway.

## Layering

Top level is by **layer**, not feature, because layers have different rules about what they may depend on.

```
src/
├── domain/          # model of the world. imports nothing else in src/.
│   ├── knowledge/   # assertion (richest type), person, project, idea, event,
│   │                # task, relation. entities are thin; assertions carry the substance.
│   │                # grouped by concept, NOT by pattern (no entities/ value-objects/ folders)
│   ├── events/      # past tense, immutable
│   ├── commands/    # imperative, rejectable, carries confidence
│   ├── policies/    # application (what may apply unattended), merge, retention.
│   │                # pure. holds the `remove` rule (ADR-0007).
│   └── values/      # time-range, provenance, entity-ref. NOT confidence.
│
├── capture/         # ingestion. normalizes input, owns nothing semantic.
│   ├── ingestion.ts
│   ├── normalizers/ # email quoting, transcript cleanup, markdown
│   └── capture-record.ts
│
├── inference/       # the probabilistic half. NOTHING HERE WRITES.
│   ├── extraction/  # extractor + constrained output schema
│   ├── resolution/  # candidates (blocking), scorer, adjudicator
│   ├── proposal/    # differ: resolved state vs current → commands. deterministic.
│   └── calibration/ # eval-set, thresholds (keyed by model), triage-policy
│                    # triage may only be downgraded by domain policy, never upgraded
│
├── application/     # use cases / orchestration. no domain rules.
│   ├── ingest-capture.ts
│   ├── propose-changes.ts
│   ├── triage-proposals.ts
│   ├── apply-command.ts      # the executor
│   ├── adjudicate.ts
│   └── rebuild-projection.ts
│
├── ports/           # interfaces in OUR vocabulary
│   ├── person-repository.ts
│   ├── event-store.ts
│   ├── extractor.ts          # task-shaped, not vendor-shaped
│   ├── adjudicator.ts
│   └── vector-index.ts
│
├── infrastructure/  # the ONLY place that knows SQLite/Drizzle, Anthropic, OpenAI, LMStudio
│   ├── sqlite/      # repositories, event store, projections/
│   ├── llm/         # one adapter per vendor + shared/ (retry, timeout, token accounting)
│   └── embeddings/
│
└── interfaces/      # drivers: Svelte UI, Tauri commands, workers
```

### Why each folder exists

- **`domain/`** — the only part that would still make sense if everything else were rewritten. Readable to understand what the system is *about*, with no DB calls in the way. **If it ends up thin, that's real information**: we built a pipeline, not a knowledge model.
- **`capture/`** — no semantic reasoning at all; normalization is identical regardless of how text arrived. Most likely future extraction into a separate process, so keep the seam cheap.
- **`inference/`** — highest-value boundary in the tree, because it encodes a rule nothing else can express: **nothing in here writes.** A stray write is then visible in a diff instead of discovered in production.
- **`application/`** — "load this, call that, write, publish." Fact about the program, not the world. Test: would it still be true with a different UI but the same world? Yes → domain. Only describes a sequence we perform → application.
- **`ports/`** — so the dependency arrow points inward. Payoff is in-memory implementations: run the whole pipeline with no network for tests and eval runs.
- **`infrastructure/`** — containment. Swapping an embedding model or a provider has a one-directory blast radius.
- **`interfaces/`** — adding a CLI or a mobile entry point is a new folder here and zero changes elsewhere.

### Rules

- **Dependencies point inward.** `domain/` imports nothing in `src/`. `application/` imports domain + ports. `infrastructure/` imports ports and implements them.
- **Only the composition root imports `infrastructure/`.** Enforce with a lint rule early — this is the boundary that erodes first.
- The layering is **hexagonal** (Cockburn), the contents of `domain/` borrow tactical DDD, none of strategic DDD appears. Payoff is **testability, not swappability** — DB swaps almost never happen.
- Two seams doing the real work: **capture → inference** (raw input becomes semantic reasoning) and **inference → application** (uncertainty becomes commitment). These justify the structure's overhead; the rest is standard layering.

### Ports: task-shaped, not vendor-shaped

- Don't define one generic `LlmClient` — that's the vendor's abstraction. Extraction needs schema-constrained structured output over a whole note; adjudication needs a small pick-one-of-N with a score. Different shapes, different requirements.
- Define `Extractor` and `Adjudicator` ports instead, named after what the domain needs. The adapter owns the prompt, schema, parsing, and vendor call. Adding LMStudio = one new file.
- **Test:** if the interface signature mentions `temperature`, `max_tokens`, or `messages[]`, it's an OpenAI-shaped port wearing a generic name.
- Caveat: task-shaped ports mean the prompt lives per-adapter → N copies drifting apart. Fix: shared prompt template in `infrastructure/llm/shared/`, with per-adapter differences confined to *how structured output is requested* (tool use vs JSON mode vs grammar constraints — these genuinely differ).
- **Record provider + model version in every proposal's provenance**, or the eval set is measuring an average across models and calibration is meaningless.

## Not yet mapped

Whole stages still undesigned:

- **Surface** — resurfacing, review UI, search over entities. Only the write path is designed. Separate diagram.
- **Enrichment** — embeddings, chunking, backlink derivation. Hangs off the projection, not the command path. Separate diagram.

Opened by the ADRs, needs answering before schema work:

- ~~Merge/split semantics~~ — **DECIDED (ADR-0009).** Events, not rewrites; merged-away ids survive as transitive redirects in the projection. One piece still open: the default disposition for assertions the user doesn't classify during a split (provisionally: stay with the original identity).
- **Assertion predicate vocabulary (ADR-0004).** Closed set, open set, or LLM-proposed-then-triaged? An open set means extraction can invent predicates and the graph fragments; a closed set means new kinds of claim need a code change.
- **Current-state query shape (ADR-0004, -0005).** "What does Otto believe about Sarah now" is a query over live assertions, not a row read. This is the main driver of projection complexity and is unspecified.
- **Snapshotting (ADR-0005).** Replay cost grows with the log. Not urgent at single-user volume, not designed either.
- **Event versioning / upcast path (ADR-0005).** Accepted as a permanent discipline; no mechanism chosen.
- **Auto-apply sampling rate (ADR-0006).** What slice of high-confidence auto-applies gets forced into review to keep calibration unbiased? Must exist from day one — cannot be reconstructed retroactively.
- ~~**SQLite validation (ADR-0004, -0005).** Append-only log + rebuildable projections + vector search at single-user scale is assumed to work, and unvalidated. Worth a spike before committing.~~ — **VALIDATED (spike run).** All seven bars in `runtime.md` §4 pass, the closest by 20×. Vector search, the predicted failure, passes by 330× on `sqlite-vec`. Still passing at 25× the corpus. Harness and results in `spikes/sqlite/`.

## Naming conventions

- Ask **what does this own?** Stored data → **repository**. A conversation with someone else's system → **client**. A decision rule → **policy**. A sequence of steps → **service** / orchestrator. Nothing, just reacts → **handler** (thin, delegates).
- **Provider / adapter** is only meaningful if there's more than one implementation. One and always one → it's a client, and the layer is free indirection.
- **Manager / Helper / Util / Processor** = the responsibility isn't crisp yet. Diagnostic, not a name.
- Deployables vs in-process: **service** (owns a capability, can fail on its own), **worker** (no inbound HTTP, pulls from a queue) vs everything else which is a module inside one of those.
- Naming a box: top line = responsibility (still true if the tech were swapped), bottom line = technology.
- Diagrams: everything is a box; a box earns its place by **failing independently**; arrows point caller → callee and carry a verb; one altitude per diagram.
