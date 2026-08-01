# Local inference is the default; cloud is opt-in and configurable

---
Status: accepted
Amends: ADR-0013
---

Otto runs local models by default. Cloud providers are configured by the user, per port, and Otto is fully functional before any provider is configured and after any provider is removed.

This reverses one sentence of ADR-0013 — "extraction defaults to Claude, supports OpenAI, and degrades to a Qwen-class 7–8B instruct model" — and the "cloud by default, local supported" framing that `runtime.md` §2 built on it. The rest of ADR-0013 stands: the sidecar, the named models and their budgets, transcription and embeddings being local always, and the spike.

**The PRD never said cloud was the default.** §4.6 says "cloud inference is a choice, not a requirement," §6 says cloud providers are "an option for quality, never a requirement to function," and §7.1 puts "local inference supported" in MVP scope. ADR-0013 introduced a cloud default that no product statement asked for, and `runtime.md` §2 and `stack.md` inherited it. A local-first product whose out-of-the-box behaviour sends every note to a third party is local-*capable*, not local-first, and the distinction is the whole product claim.

**Defaulting to cloud also hides the risk that matters most.** ADR-0013 names schema-constrained extraction from a 7–8B model as the assumption most likely to be wrong in all of Otto, and that measurement is still the one open gate (`prd.md` §9). If cloud is the default, no ordinary use exercises the local path, and the gate stays theoretical indefinitely while the product ships on an untested claim. Making local the default means the weakest component is the one under continuous observation — which is uncomfortable and correct.

**"Degrades to local" was the wrong direction of travel.** Degradation implies a fallback entered on failure. Local is the baseline Otto is built to run on, and cloud is an upgrade the user opts into for extraction quality. That reframing changes what has to be true: local output quality is a release criterion rather than a contingency, and the eval set measures the default path rather than an alternative one.

## What this does not change

- **Thresholds stay keyed by model and version** (ADR-0008). This decision makes that mechanism load-bearing rather than incidental: the default model is now the weaker one, so more Proposals land in review, which is the correct degradation and the reason the threshold design exists.
- **Transcription and embeddings are unaffected** — they were already local always, with no cloud option (ADR-0013).
- **The ports do not change** (ADR-0008). `Extractor` and `Adjudicator` are task-shaped, and which adapter satisfies them is a configuration question. Nothing in the domain or inference layers learns that a provider is remote.

## Considered Options

- **Cloud default, local supported (ADR-0013 as written)** — rejected above. It is the better *quality* answer and the wrong *product* answer, and it contradicts three PRD statements.
- **Local only; no cloud adapters in MVP** — rejected. Cloud measurably improves extraction, the adapters are cheap because the ports are task-shaped, and refusing the option is dogma rather than privacy. The privacy claim is about the default and about consent, not about capability.
- **Ask the user to choose on first run** — rejected as the primary mechanism. A setup screen that asks an unanswerable question before the user has seen the product is a worse default than a working one, and it converts a principle into a prompt. Cloud remains discoverable in settings.

## Consequences

- **Otto must be fully functional with no provider configured**, from first launch. This is now a release criterion rather than a degradation path, and `qa.md` should test the unconfigured state as the primary configuration rather than an edge case.
- **The local-extraction quality gate now blocks the default experience**, not an alternative one. If an 8B model cannot clear the floor ADR-0013 states — a usable knowledge base with more review friction, not a corrupted one — the response remains to raise the minimum local model size, never to loosen thresholds, and never to quietly restore the cloud default to hide it.
- **First-run cost is higher.** A local model must be present before extraction can run at all. The bundled transcription and embedding models already put ~650 MB in the installer; whether the extraction model is bundled, downloaded on first run, or expected from an existing LMStudio/Ollama install is an open packaging question this ADR does not settle.
- **Cloud configuration is per port, not global.** A user may want cloud extraction and local adjudication, and the ports already make that a configuration rather than a code path.
- **Provenance carries the provider on every Proposal** (ADR-0008), so a knowledge base built across a configuration change remains legible — which facts came from a local model and which from a provider is answerable after the fact.
