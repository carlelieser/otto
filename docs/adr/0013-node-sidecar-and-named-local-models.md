# The pipeline runs as a Node sidecar; local inference is named, budgeted, and gated by a spike

---
Status: accepted
---

ADR-0008 committed Otto to running fully locally, and PRD §4.6 made it a principle. Neither named a model or stated a budget, which leaves "degrades to local" as an aspiration rather than a requirement anything can be tested against. ADD §4 established three processes without saying how a TypeScript pipeline is hosted inside a Rust application. Both are settled in [`runtime.md`](../runtime.md).

**The pipeline runs as a Node sidecar process, spawned and supervised by the Tauri host**, communicating over JSON-RPC on stdio, with SQLite in WAL mode shared between the writing sidecar and the reading host. Rewriting the pipeline in Rust was the honest alternative and lost on ecosystem grounds: the provider clients, structured-output handling, and Drizzle are all TypeScript, and reimplementing them buys nothing the product needs, since Otto's hard parts are extraction quality and triage rather than throughput. Running the pipeline in the WebView was rejected by ADD §4's own argument that capture must stay cheap and the pipeline must outlive the window. Stdio rather than a local HTTP port because a local-first application should not open a socket it then has to reason about.

**Transcription is `whisper.cpp` with `small.en`, bundled**, at a budget of ≤2× realtime on an 8-core consumer machine. The accuracy metric is proper-noun recall rather than general word error rate, because a mis-transcribed name is a resolution failure and unusual names are what small models miss. Entity names from the projection are supplied as a transcription prompt to improve that recall.

**Extraction defaults to Claude, supports OpenAI, and degrades to a Qwen-class 7–8B instruct model under grammar-constrained decoding.** This is the assumption most likely to be wrong in all of Otto, and it is named as such: constrained decoding guarantees parseable output, not correct output. The floor Otto must clear to claim local support is that **the local path produces a usable knowledge base with more review friction, not a corrupted one** — and because thresholds are per model (ADR-0008), a weaker model produces lower Confidence and therefore more review rather than more error. If the eval set shows an 8B model cannot clear that floor, the response is to raise the minimum local model size, never to loosen thresholds to compensate.

**Embeddings are local always, with no cloud option** — they serve candidate generation rather than user-facing search, and sending every entity to a provider for a job a 130 MB local model does well is a privacy cost with no return.

**The SQLite assumption is gated by a spike with stated pass and fail bars** over a synthetic 5-year corpus, run before schema work. The bars are in `runtime.md` §4. Vector search is the likeliest failure since it is the one thing SQLite does not do natively; the fallback is a separate index rebuilt from the log like any other projection, which is contained precisely because embeddings are already derived state (ADR-0005). If several bars fail together, the conclusion is that the projection model does too much work per event — not that a different database is needed.

> **Outcome (spike run).** All seven bars passed, the closest by a factor of 20. Vector search — the predicted failure — cleared its bar by 330×, so the separate-index fallback is not needed. The extension has since changed: the spike measured `asg017/sqlite-vec` 0.1.9, and Otto ships `sqliteai/sqlite-vector` 1.0 (`runtime.md` §4.3). The bar and the conclusion are unchanged. The decision below stands unchanged; results are in `runtime.md` §4. The gate this ADR set is therefore half cleared: SQLite passed, and the local-extraction measurement has not yet been run.

## Considered Options

- **Rewrite the pipeline in Rust** — rejected above; the honest option, and the one to revisit if the sidecar proves operationally annoying.
- **Embed a JS runtime in the Rust host** — rejected: one fewer process, at the cost of a constrained runtime and a crash surface shared with the tray.
- **Leave local models unnamed until after MVP** — rejected: an untestable requirement is not a requirement, and this is the assumption most likely to invalidate the design.
- **Assume SQLite and find out later** — rejected: discovering it a year in is the expensive direction, and the spike is days.

## Consequences

- **A crashing sidecar degrades to "Captures accumulate"**, which is the same state as an unavailable provider (ADD §11) and already handled. The supervisor restarts with backoff, and because the pipeline is resumable per stage, a restart resumes rather than replays.
- Bundling `whisper.cpp` and an embedding model puts roughly 650 MB in the installer before the application's own code. Accepted: working offline on first launch is worth more than a small download.
- Local extraction may require decomposition into several narrower prompts if whole-note extraction proves unreliable at 8B, trading latency for reliability. Latency is affordable because nothing is waiting on the pipeline.
- The spike's outcome may change the process model. It is run first for that reason. **It did not** — the storage design stands as written, and schema work is unblocked.
