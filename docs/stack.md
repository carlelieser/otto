# Otto — Technology Stack

> Status: accepted for MVP, and derivative. Architecture in [`add.md`](./add.md); runtime and inference in [`runtime.md`](./runtime.md); settled decisions in [`docs/adr/`](./adr/).
>
> This document decides nothing. It collects the technology choices already made in `add.md`, `runtime.md`, and the ADRs into one place, because they were settled across three documents and there was nowhere to read the stack off in full. Every row points at the document that owns it — **where this page and its source disagree, this page is wrong** and should be corrected rather than argued with.

## 1. How to read this

Otto is a local-first desktop application: a Rust host, a Svelte WebView, and a TypeScript pipeline in a Node sidecar, over one SQLite file. Nothing here is a service, and nothing here requires a network to function (PRD §6).

Two properties explain most of the choices below, and are worth holding while reading:

**Local must actually work, not nominally work.** ADR-0008 and PRD §4.6 make fully local operation a requirement. That is why transcription and embeddings have no cloud option at all, and why the local extraction path is named and budgeted rather than described as a fallback.

**Almost everything is derived.** The event log and Captures are the only truth (ADR-0005); entity tables, indexes, embeddings, and salience are projections. A technology that holds only derived state is cheap to replace — swapping the vector index is a rebuild rather than a migration, which is exactly what made changing it after the spike a low-cost decision.

## 2. The stack at a glance

| Layer | Choice | Owned by |
|---|---|---|
| Application shell | Tauri — Rust host process | ADD §4, ADR-0013 |
| UI | Svelte, in the WebView | ADD §3, §4 |
| Pipeline runtime | Node sidecar, TypeScript | ADR-0013, `runtime.md` §1 |
| Host ↔ sidecar transport | JSON-RPC over stdio | ADR-0013, `runtime.md` §1 |
| Database | SQLite, WAL mode | ADR-0005, ADR-0013 |
| Query layer | Drizzle | ADD §3 |
| Vector index | SQLite-Vector 1.0 (`sqliteai/sqlite-vector`), loadable extension | `runtime.md` §4.3 |
| Full-text search | SQLite FTS | `runtime.md` §4 |
| Transcription | `whisper.cpp`, `small.en`, bundled | ADR-0013, `runtime.md` §2 |
| Extraction / adjudication — default | Qwen-class 7–8B instruct, GBNF-constrained, via LMStudio or Ollama | ADR-0016, `runtime.md` §2 |
| Extraction / adjudication — opt-in | Claude (Sonnet tier), OpenAI | ADR-0016, ADR-0008, `runtime.md` §2 |
| Embeddings | `bge-small-en-v1.5` or equivalent, local always | ADR-0013, `runtime.md` §2 |

## 3. Process model

Otto runs as three processes, and the split is architectural rather than packaging (ADD §4).

```mermaid
flowchart LR
    subgraph host["Tauri host — Rust"]
        Cmd["Command surface"]
        Sup["Sidecar supervisor"]
        Audio["Audio + tray + hotkey"]
    end
    subgraph side["Sidecar — Node"]
        Work["Pipeline worker"]
        Proj["Projection worker"]
    end
    WV["WebView — Svelte"]
    DB[("SQLite — WAL")]

    WV <-->|invoke| Cmd
    Cmd -->|"stdio JSON-RPC"| Sup
    Sup <--> Work
    Work --> DB
    Proj --> DB
    WV -->|read-only| Cmd
```

**Why a Node sidecar rather than Rust.** The provider clients, structured-output handling, and Drizzle are all TypeScript, and reimplementing them in Rust buys nothing the product needs — Otto's hard parts are extraction quality and triage, not throughput. `runtime.md` §1 has the full comparison, including the two other rejected options (pipeline in the WebView, embedded JS runtime).

**Why stdio rather than a local HTTP port.** Nothing to conflict with, nothing to firewall, nothing to accidentally expose. For a local-first application that matters more than the ergonomics.

**Why WAL.** The sidecar writes and the host reads on behalf of the WebView — concurrent readers with a single writer is the case WAL is built for, and ADD §4 serialises the pipeline to one Capture at a time, so there is exactly one writer by construction.

**Failure behaviour.** The supervisor restarts the sidecar with backoff. Because the pipeline is resumable per stage, a restart resumes rather than replays, and a crash loop degrades to "Captures accumulate" — the same state as an unavailable provider, which ADD §11 already handles.

## 4. Storage

**SQLite, one file, WAL mode.** Assumed by ADR-0005 and validated by the spike in `runtime.md` §4 — all seven bars passed over a synthetic 5-year corpus, the closest by a factor of 20.

**The vector index is SQLite-Vector 1.0** — [`sqliteai/sqlite-vector`](https://github.com/sqliteai/sqlite-vector), `runtime.md` §4.3. It is a loadable binary extension rather than an npm package, with prebuilt artefacts per platform, and it stores vectors as ordinary `BLOB` columns rather than in a virtual table. Otto stores Float32 and does not use the available quantization; §4.3 has the reasoning and the two things still to confirm — a re-measurement against the standing bar, and the licence.

The spike validated SQLite itself, not a dependency list — it was throwaway code, and the packages it happened to use are not decisions. The application's SQLite driver is unspecified; §8 records it as open.

**Snapshotting is built but switched off** (`runtime.md` §4.1). Full rebuild is 215 ms at the specified corpus; the cadence is set to never and revisited if the log passes ~1M events. The mechanism is the expensive part to add later; the cadence is a constant.

## 5. Inference

Ports are named after tasks, never after vendors (ADR-0008). `Extractor`, `Adjudicator`, `Transcriber`, and `Embedder` are the four that reach a model, and nothing in their signatures knows an LLM is involved — which is exactly what lets a fully local runtime satisfy them.

### Transcription — local, non-negotiable

**`whisper.cpp` with `small.en`, bundled**, at ≤2× realtime on an 8-core consumer machine. Voice is the primary capture path, and a capture path that requires a network is not a local-first system. `large-v3` is an optional download.

The metric is proper-noun recall rather than general word error rate: a mis-transcribed name is a resolution failure. Entity names from the projection are supplied to the transcriber as an initial prompt to improve it, and transcripts stay user-correctable (`runtime.md` §5).

### Extraction and adjudication — local default, cloud opt-in

| Path | Model | Notes |
|---|---|---|
| Default | Qwen-class 7–8B instruct, GBNF-constrained, via LMStudio or Ollama | What Otto runs with nothing configured (ADR-0016) |
| Opt-in | Claude (Sonnet tier) | Best structured-output reliability; the quality ceiling |
| Opt-in | OpenAI | Second adapter, same ports |

Otto is fully functional with no provider configured, and cloud is chosen per port rather than globally. This is the reverse of ADR-0013 as originally written; ADR-0016 has the reasoning.

Per-adapter differences are confined to *how* structured output is requested — tool use, JSON mode, or grammar constraints — over a shared prompt template in `infrastructure/llm/shared/` (ADR-0008).

**Thresholds are keyed by model and version** (ADR-0008). A confidence of 0.8 from a local model is not the same number as 0.8 from Claude, and provenance records provider and model version on every Proposal.

### Embeddings — local always, no cloud option

**`bge-small-en-v1.5` or equivalent.** Embeddings serve candidate generation rather than user-facing search (ADD §9), the quality bar is "narrow thousands of entities to a handful," and sending every entity to a provider for a job a 130 MB local model does well is a privacy cost with no return.

## 6. What the choices cost

Stated because a stack page that lists only benefits is a sales document.

- **Roughly 650 MB in the installer** before Otto's own code, from bundling `whisper.cpp` and an embedding model (ADR-0013). Accepted: working offline on first launch is worth more than a small download.
- **Three providers means three copies of the extraction prompt** drifting apart — the acknowledged cost of task-shaped ports (ADR-0008), mitigated by the shared template above.
- **A third process to supervise.** Rewriting the pipeline in Rust remains the option to revisit if the sidecar proves operationally annoying (ADR-0013).
- **The vector extension is a native binary per platform.** SQLite-Vector ships prebuilt artefacts rather than an npm package, so it joins `whisper.cpp` and the embedding model as something the installer must carry per target (`runtime.md` §4.3).

## 7. The assumption most likely to be wrong

**Schema-constrained extraction from a 7–8B local model.** Named as such in both ADR-0013 and `runtime.md` §2: grammar-constrained decoding guarantees *parseable* output, not *correct* output.

The floor Otto must clear to claim local support is that **the local path produces a usable knowledge base with more review friction, not a corrupted one.** If the eval set shows an 8B model cannot clear it, the response is to raise the minimum local model size, never to loosen thresholds to compensate.

**This is the one gate still open.** `prd.md` §9 lists two technical gates on implementation; the SQLite spike was the other and has passed. The local-extraction quality measurement has not been run.

## 8. Not yet decided

Genuinely open, rather than decided elsewhere and omitted here.

- **Test framework and runner.** `qa.md` specifies tiers, rigour, and release criteria, and names the *kinds* of test required — property-based tests and in-memory integration tests among them — but no runner, assertion library, or property-testing library is chosen.
- **The SQLite driver.** The spike used `better-sqlite3`; nothing decides what the sidecar uses, and the driver must be able to load a binary extension (`runtime.md` §4.3).
- **SQLite-Vector's licence**, which GitHub does not report as a recognised SPDX identifier. Worth confirming before it is bundled into a distributed installer.
- **Build and packaging pipeline.** How the sidecar, `whisper.cpp`, the embedding model, and the vector extension are bundled into a Tauri installer per platform.
- **Svelte version and UI dependencies.** ADD §3 names Svelte; nothing specifies a version, router, or component approach.
- **Node version for the sidecar**, and how it is shipped alongside the Tauri binary.
