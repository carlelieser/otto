# Otto — Documentation

All decisions needed to begin implementation are settled. Where these documents conflict, it is a bug worth fixing rather than a judgement call to make at the keyboard.

## Read in this order

| Document | What it answers |
|---|---|
| [`../CONTEXT.md`](../CONTEXT.md) | What the words mean. Read first — everything else uses this vocabulary precisely. |
| [`prd.md`](./prd.md) | What Otto is, who it is for, what it does and refuses to do. |
| [`add.md`](./add.md) | How it is built: layers, the write and read paths, the runtime, the data model. |
| [`schema.md`](./schema.md) | What Otto may know — every field, its type, its cardinality, and the relation vocabulary. |
| [`triage.md`](./triage.md) | How uncertainty becomes a decision: confidence, thresholds, dispositions, sampling. |
| [`runtime.md`](./runtime.md) | Process model, local models with budgets, the SQLite spike and its results, transcript correction. |
| [`salience.md`](./salience.md) | What gets surfaced and what goes in a brief. v0, expected to be replaced. |
| [`qa.md`](./qa.md) | What to test, at what rigour, and in what order. |
| [`stack.md`](./stack.md) | Every technology choice in one place. Derivative — a summary of the above, not a source. |
| [`adr/`](./adr/) | Why each decision went the way it did, including the one that was reversed. |

## Decision record

| ADR | Decision |
|---|---|
| [0001](./adr/0001-hexagonal-layering-with-tactical-ddd.md) | Hexagonal layering, tactical DDD vocabulary, no strategic DDD |
| [0002](./adr/0002-domain-is-personal-knowledge-and-its-revision.md) | The domain is personal knowledge and its revision over time |
| [0003](./adr/0003-inference-layer-cannot-write.md) | The inference layer cannot write; the executor is the only writer |
| [0004](./adr/0004-assertions-are-first-class-entities.md) | ~~Assertions are first-class entities~~ — **reversed by 0010** |
| [0005](./adr/0005-event-sourcing-with-rebuildable-projections.md) | Event sourcing; the log is truth, entity tables are projections |
| [0006](./adr/0006-corrections-record-counterfactuals-for-calibration.md) | Corrections record the counterfactual; feedback is for calibration |
| [0007](./adr/0007-llm-boundaries-and-triage-placement.md) | Where the LLM's job ends; triage splits across two layers |
| [0008](./adr/0008-task-shaped-ports-not-vendor-shaped.md) | Ports are named after tasks, not vendors |
| [0009](./adr/0009-merge-and-split-semantics.md) | Merge and split are events; merged identities survive as redirects |
| [0010](./adr/0010-entities-carry-fields-assertions-reversed.md) | Entities carry fields; ADR-0004 is reversed |
| [0011](./adr/0011-mechanics-of-an-immutable-log.md) | Snapshots, upcasts, staleness, idempotency |
| [0012](./adr/0012-thresholds-bootstrap-and-minimal-merge.md) | Confidence combination, bootstrap, minimal merge in MVP |
| [0013](./adr/0013-node-sidecar-and-named-local-models.md) | Node sidecar; named local models; the SQLite spike (run — passed) — extraction default **amended by 0016** |
| [0014](./adr/0014-typed-fields-closed-relations-visible-discards.md) | Closed field and relation vocabularies; discards stay visible |
| [0015](./adr/0015-salience-is-a-legible-projection.md) | Salience is a legible projection; v0 ships crude |
| [0016](./adr/0016-local-inference-is-the-default.md) | Local inference is the default; cloud is opt-in and configurable per port |
| [0017](./adr/0017-pinned-runtime-toolchain-and-sidecar-spawn.md) | Pinned Rust and Tauri versions; `cpal`/`hound` for audio; the sidecar spawn seam |
| [0018](./adr/0018-voice-ingestion-is-one-call.md) | Voice ingestion is one sidecar call; the host supplies recording-start time |

## Before the first line of code

Two things ran first, in this order, because both can change the design:

1. ~~**The SQLite spike**~~ ([`runtime.md`](./runtime.md) §4) — **done, passed on all seven bars.** The storage design is unchanged and schema work is unblocked. The harness was throwaway and is not kept.
2. **Local extraction measurement** ([`runtime.md`](./runtime.md) §2) — whether a 7–8B model under grammar constraints clears the stated floor. Still to run, and now the assumption in Otto most likely to be wrong. ADR-0016 raises its stakes: local is the default path, so this measures what every user gets rather than a fallback.

After those, [`qa.md`](./qa.md) §12 has the build order.

## What is deliberately unresolved

Each names the signal that will answer it:

- **Whether the thresholds are right.** They start strict; calibration moves them ([`triage.md`](./triage.md) §2).
- **Whether salience v0 fails as predicted.** Brief instrumentation answers it ([`salience.md`](./salience.md) §3, §5).
- **Whether the relation vocabulary is too small.** Watch `relates_to`'s share of the graph.
- **Whether the schema is missing fields.** Watch `notes` growth.
- **Split.** Semantics settled ([0009](./adr/0009-merge-and-split-semantics.md)); the per-value review interface is post-MVP.

## Historical

[`other/`](./other/) holds pre-specification scratchpads. They are superseded in full, contain reversed decisions, and are kept only for the reasoning behind them.
