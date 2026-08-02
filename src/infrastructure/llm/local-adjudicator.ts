import { parseChoice } from "../../inference/resolution/parse-adjudication.js";
import type { Adjudication, AdjudicationRequest, Adjudicator } from "../../ports/adjudicator.js";
import { adjudicationPrompt } from "./shared/adjudication-prompt.js";
import { chatResponseJson, type FetchLike, providerFailure } from "./shared/provider-failure.js";

/**
 * Adjudication against the local model, over the same OpenAI-compatible
 * endpoint `LocalExtractor` uses (ADR-0016, `runtime.md` §2).
 *
 * Configured per port rather than globally, per `add.md` §9: a user may want
 * cloud extraction and local adjudication, since the two are different jobs
 * with different costs. Extraction reads a whole note under a grammar;
 * adjudication picks one of four, which a smaller model does well.
 *
 * Temperature 0, as everywhere on the write path. Adjudication is a reading
 * task, and sampling variety in a reading task is noise the eval set would
 * measure as model error.
 */
export class LocalAdjudicator implements Adjudicator {
  readonly #options: Required<LocalAdjudicatorOptions>;
  readonly #fetch: FetchLike;

  constructor(options: LocalAdjudicatorOptions = {}, fetchLike: FetchLike = fetch) {
    this.#options = { ...LOCAL_ADJUDICATOR_DEFAULTS, ...options };
    this.#fetch = fetchLike;
  }

  async adjudicate(request: AdjudicationRequest): Promise<Adjudication> {
    const response = await this.#post(request);
    const answer = chatResponseJson(response, this.#options.model);
    return {
      chosenIndex: parseChoice(answer, request.candidates.length),
      provider: LOCAL_ADJUDICATOR_PROVIDER,
      modelVersion: this.#options.model,
    };
  }

  async #post(request: AdjudicationRequest): Promise<unknown> {
    const response = await this.#fetch(`${this.#options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.#body(request)),
    });
    if (response.ok) return response.json();
    throw await providerFailure(
      response,
      `${LOCAL_ADJUDICATOR_PROVIDER} at ${this.#options.baseUrl}`,
    );
  }

  /**
   * The request body.
   *
   * Temperature 0, as everywhere on the write path, and `json_object` rather
   * than a grammar: the answer is one number, so the shape a grammar would
   * constrain is small enough that JSON mode covers it — and `parseChoice`
   * treats anything unreadable as a decline rather than trusting the format.
   */
  #body(request: AdjudicationRequest): Record<string, unknown> {
    return {
      model: this.#options.model,
      messages: [{ role: "user", content: adjudicationPrompt(request) }],
      temperature: 0,
      response_format: { type: "json_object" },
    };
  }
}

/** The provider recorded on everything this adapter decides (ADR-0008). */
export const LOCAL_ADJUDICATOR_PROVIDER = "local";

export interface LocalAdjudicatorOptions {
  readonly baseUrl?: string;
  readonly model?: string;
}

const LOCAL_ADJUDICATOR_DEFAULTS = {
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "qwen2.5-7b-instruct",
} as const satisfies Required<LocalAdjudicatorOptions>;
