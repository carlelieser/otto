import { outputSchema } from "../../inference/extraction/output-schema.js";
import { parseExtraction } from "../../inference/extraction/parse-extraction.js";
import { toJsonSchema } from "../../inference/extraction/to-json-schema.js";
import type { Extraction, ExtractionRequest, Extractor } from "../../ports/extractor.js";
import { extractionPrompt } from "./shared/extraction-prompt.js";
import { chatResponseJson, type FetchLike, providerFailure } from "./shared/provider-failure.js";

/**
 * Extraction against OpenAI, opt-in (ADR-0016).
 *
 * The second cloud adapter, and the one that proves the port is not
 * Anthropic-shaped by accident. It differs from the other two in exactly one
 * respect — structured output is requested through `response_format` with a
 * strict JSON Schema, where Claude uses tool use and the local path uses a
 * grammar. Prompt and schema are shared.
 */
export class OpenAiExtractor implements Extractor {
  readonly #options: Required<OpenAiOptions>;
  readonly #fetch: FetchLike;

  constructor(options: OpenAiOptions, fetchLike: FetchLike = fetch) {
    this.#options = { ...OPENAI_DEFAULTS, ...options };
    this.#fetch = fetchLike;
  }

  async extract(request: ExtractionRequest): Promise<Extraction> {
    const response = await this.#post(request);
    const { mentions, violations } = parseExtraction(
      chatResponseJson(response, this.#options.model),
    );
    return { mentions, violations, provider: OPENAI_PROVIDER, modelVersion: this.#options.model };
  }

  async #post(request: ExtractionRequest): Promise<unknown> {
    const response = await this.#fetch(`${this.#options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#options.apiKey}`,
      },
      body: JSON.stringify(this.#body(request)),
    });
    if (!response.ok) throw await providerFailure(response, OPENAI_PROVIDER);
    return response.json();
  }

  /**
   * `json_schema` with `strict: true`, which is this provider's constrained
   * decoding rather than an instruction it may ignore. That is what keeps its
   * schema violation rate comparable to the local path's, so the eval set's
   * per-provider numbers measure field-value accuracy rather than compliance.
   */
  #body(request: ExtractionRequest): Record<string, unknown> {
    return {
      model: this.#options.model,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: { name: SCHEMA_NAME, strict: true, schema: toJsonSchema(outputSchema()) },
      },
      messages: [{ role: "user", content: extractionPrompt(request) }],
    };
  }
}

export const OPENAI_PROVIDER = "openai";

const SCHEMA_NAME = "mentions";

export interface OpenAiOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
}

const OPENAI_DEFAULTS = {
  model: "gpt-4.1",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
} as const satisfies Required<OpenAiOptions>;
