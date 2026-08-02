import { outputSchema } from "../../inference/extraction/output-schema.js";
import { parseExtraction } from "../../inference/extraction/parse-extraction.js";
import { toJsonSchema } from "../../inference/extraction/to-json-schema.js";
import type { Extraction, ExtractionRequest, Extractor } from "../../ports/extractor.js";
import { extractionPrompt } from "./shared/extraction-prompt.js";
import { type FetchLike, providerFailure } from "./shared/provider-failure.js";

/**
 * Extraction against Claude, opt-in (ADR-0016).
 *
 * The quality ceiling the local path is measured against (`runtime.md` §2), and
 * an upgrade the user chooses rather than a fallback entered on failure — which
 * is why nothing in Otto reaches for this when the local path is unavailable.
 *
 * The one thing that differs from the other two adapters is **how** structured
 * output is requested: here it is tool use with a JSON Schema, where the local
 * path uses a grammar and OpenAI uses response-format. What is asked for comes
 * from the shared prompt and the shared schema, which is ADR-0008's mitigation
 * for the cost it accepts.
 */
export class AnthropicExtractor implements Extractor {
  readonly #options: Required<AnthropicOptions>;
  readonly #fetch: FetchLike;

  constructor(options: AnthropicOptions, fetchLike: FetchLike = fetch) {
    this.#options = { ...ANTHROPIC_DEFAULTS, ...options };
    this.#fetch = fetchLike;
  }

  async extract(request: ExtractionRequest): Promise<Extraction> {
    const response = await this.#post(request);
    const { mentions, violations } = parseExtraction(toolInput(response, this.#options.model));
    return {
      mentions,
      violations,
      provider: ANTHROPIC_PROVIDER,
      modelVersion: this.#options.model,
    };
  }

  async #post(request: ExtractionRequest): Promise<unknown> {
    const response = await this.#fetch(`${this.#options.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#options.apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify(this.#body(request)),
    });
    if (!response.ok) throw await providerFailure(response, ANTHROPIC_PROVIDER);
    return response.json();
  }

  #body(request: ExtractionRequest): Record<string, unknown> {
    return {
      model: this.#options.model,
      max_tokens: this.#options.maxTokens,
      temperature: 0,
      ...STRUCTURED_OUTPUT,
      messages: [{ role: "user", content: extractionPrompt(request) }],
    };
  }
}

export const ANTHROPIC_PROVIDER = "anthropic";

const TOOL_NAME = "record_mentions";

const TOOL_DESCRIPTION =
  "Record the entities this note mentions and the values it states about them.";

/**
 * How this provider is asked for structured output: tool use, with
 * `tool_choice` pinned to the one tool.
 *
 * Pinning is what makes the response shape predictable. An unpinned
 * `tool_choice` lets the model answer in prose when it judges the tool
 * unnecessary, and "no entities in this note" is exactly the case where it
 * would — turning a valid empty extraction into a parse failure.
 *
 * A constant rather than lines in `#body` because it is a table of literal
 * values: the schema is generated once from `schema.md` and cannot vary per
 * request, since nothing in a request changes what Otto is allowed to know.
 */
const STRUCTURED_OUTPUT = {
  tools: [
    { name: TOOL_NAME, description: TOOL_DESCRIPTION, input_schema: toJsonSchema(outputSchema()) },
  ],
  tool_choice: { type: "tool", name: TOOL_NAME },
} as const;

const ANTHROPIC_API_VERSION = "2023-06-01";

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
}

/** Sonnet tier, per `runtime.md` §2's table. */
const ANTHROPIC_DEFAULTS = {
  model: "claude-sonnet-4-5",
  baseUrl: "https://api.anthropic.com",
  maxTokens: 4096,
  apiKey: "",
} as const satisfies Required<AnthropicOptions>;

/** The tool call's input, which is the structured output this provider returns. */
function toolInput(response: unknown, model: string): unknown {
  const content = (response as AnthropicResponse)?.content ?? [];
  const call = content.find((block) => block?.type === "tool_use" && block?.name === TOOL_NAME);
  if (call?.input === undefined) {
    throw new Error(`Extraction from ${model} returned no ${TOOL_NAME} tool call`);
  }
  return call.input;
}

interface AnthropicResponse {
  readonly content?: readonly {
    readonly type?: string;
    readonly name?: string;
    readonly input?: unknown;
  }[];
}
