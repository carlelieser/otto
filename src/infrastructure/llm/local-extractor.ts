import { outputSchema } from "../../inference/extraction/output-schema.js";
import { parseExtraction } from "../../inference/extraction/parse-extraction.js";
import { toGbnf } from "../../inference/extraction/to-gbnf.js";
import type { Extraction, ExtractionRequest, Extractor } from "../../ports/extractor.js";
import { extractionPrompt } from "./shared/extraction-prompt.js";
import { type FetchLike, providerFailure } from "./shared/provider-failure.js";

/**
 * Extraction against a local Qwen-class 7-8B instruct model, GBNF-constrained
 * (ADR-0016, `runtime.md` §2).
 *
 * **This is the default path.** It is what Otto runs with nothing configured,
 * and the suite's baseline run has no provider credentials present at all
 * (`qa.md` §6.3). Cloud is an upgrade the user opts into for extraction
 * quality, not a fallback entered on failure.
 *
 * It talks to LMStudio or Ollama over their OpenAI-compatible chat-completions
 * endpoint, which is why one adapter covers both runtimes. That compatibility
 * is a property of the runtimes rather than of Otto: nothing above this file
 * knows an HTTP call happens, which is what ADR-0008's port shape buys.
 *
 * Temperature 0 and a grammar, per `add.md` §5.2. The grammar is generated from
 * `schema.md`'s tables, so the schema violation rate should be at or near zero
 * — and `qa.md` §6.3 is explicit that if it is not, the constraint is
 * misconfigured rather than the model being weak.
 */
export class LocalExtractor implements Extractor {
  readonly #options: Required<LocalExtractorOptions>;
  readonly #fetch: FetchLike;

  constructor(options: LocalExtractorOptions = {}, fetchLike: FetchLike = fetch) {
    this.#options = { ...LOCAL_DEFAULTS, ...options };
    this.#fetch = fetchLike;
  }

  async extract(request: ExtractionRequest): Promise<Extraction> {
    const response = await this.#post(request);
    const { mentions, violations } = parseExtraction(asJson(response, this.#options.model));
    return {
      mentions,
      violations,
      provider: LOCAL_PROVIDER,
      modelVersion: this.#options.model,
    };
  }

  async #post(request: ExtractionRequest): Promise<unknown> {
    const response = await this.#fetch(`${this.#options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.#body(request)),
    });
    if (!response.ok)
      throw await providerFailure(response, `${LOCAL_PROVIDER} at ${this.#options.baseUrl}`);
    return response.json();
  }

  /**
   * The request body.
   *
   * `grammar` is what LMStudio's llama.cpp server reads; Ollama reads the same
   * field. Both ignore an unknown key rather than rejecting the request, so
   * sending it to a runtime that does not support it degrades to unconstrained
   * decoding — which the parser then catches as schema violations rather than
   * as corrupt knowledge, and which the eval set's zero-tolerance violation
   * rate makes visible immediately.
   */
  #body(request: ExtractionRequest): Record<string, unknown> {
    return {
      model: this.#options.model,
      messages: [{ role: "user", content: extractionPrompt(request) }],
      // Schema-constrained output at temperature 0 (`add.md` §5.2). Extraction
      // is a reading task, and sampling variety in a reading task is noise the
      // eval set would measure as model error.
      temperature: 0,
      grammar: toGbnf(outputSchema()),
    };
  }
}

/** The provider recorded on everything this adapter produces (ADR-0008). */
export const LOCAL_PROVIDER = "local";

export interface LocalExtractorOptions {
  /** The OpenAI-compatible base URL LMStudio or Ollama serves. */
  readonly baseUrl?: string;
  /** The model, exactly as the runtime names it. Triage thresholds key on it. */
  readonly model?: string;
}

/**
 * LMStudio's default port and a Qwen-class 7-8B instruct model.
 *
 * A default rather than a requirement: `runtime.md` §2 says Qwen-*class*, and
 * the model name is recorded on every Proposal precisely so that running a
 * different one is legible after the fact rather than silently averaged into
 * the eval set (ADR-0006).
 */
const LOCAL_DEFAULTS = {
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "qwen2.5-7b-instruct",
} as const satisfies Required<LocalExtractorOptions>;

/**
 * The message content, parsed.
 *
 * An unreachable runtime and an unparseable response both throw, because both
 * are "extraction did not happen" — a state the pipeline handles by leaving
 * Captures accumulating (`add.md` §11). Returning an empty extraction instead
 * would durably record that the note said nothing.
 */
function asJson(response: unknown, model: string): unknown {
  const content = (response as ChatResponse)?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`Extraction from ${model} returned no message content`);
  }
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`Extraction from ${model} returned content that is not JSON`);
  }
}

interface ChatResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[];
}
