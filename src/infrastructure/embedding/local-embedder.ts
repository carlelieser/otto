import type { Embedder } from "../../ports/embedder.js";
import { type FetchLike, providerFailure } from "../llm/shared/provider-failure.js";

/**
 * `bge-small-en-v1.5` over a local runtime's OpenAI-compatible embeddings
 * endpoint (`runtime.md` §2, `stack.md` §5).
 *
 * **Local always, and there is no cloud adapter beside this one.** That is the
 * one place Otto's inference ports do not offer the cloud opt-in the others do,
 * and the argument is a cost/benefit rather than a principle: the quality bar
 * is "narrow thousands of entities to a handful," a 130 MB local model clears
 * it, and sending every entity the user knows to a provider for that job is a
 * privacy cost with no return.
 *
 * One adapter covers LMStudio and Ollama for the same reason `LocalExtractor`
 * does — the compatibility is a property of the runtimes, and nothing above
 * this file knows an HTTP call happens.
 */
export class LocalEmbedder implements Embedder {
  readonly #options: Required<LocalEmbedderOptions>;
  readonly #fetch: FetchLike;

  constructor(options: LocalEmbedderOptions = {}, fetchLike: FetchLike = fetch) {
    this.#options = { ...LOCAL_EMBEDDER_DEFAULTS, ...options };
    this.#fetch = fetchLike;
  }

  get dimensions(): number {
    return this.#options.dimensions;
  }

  get modelVersion(): string {
    return this.#options.model;
  }

  async embed(text: string): Promise<Float32Array> {
    const [vector] = await this.embedAll([text]);
    return vector!;
  }

  /**
   * Every text in one call, returned in the order given.
   *
   * The order is the contract and it is not incidental: the caller pairs each
   * vector with the entity it embedded, so a reordered response would attach
   * every entity's vector to a different entity. The endpoint returns an
   * `index` per embedding for exactly this reason, and it is sorted on rather
   * than assumed.
   */
  async embedAll(texts: readonly string[]): Promise<readonly Float32Array[]> {
    if (texts.length === 0) return [];
    const response = await this.#post(texts);
    return readEmbeddings(response, texts.length, this.#options.model);
  }

  async #post(texts: readonly string[]): Promise<unknown> {
    const response = await this.#fetch(`${this.#options.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.#options.model, input: texts }),
    });
    if (!response.ok) {
      throw await providerFailure(response, `${EMBEDDING_PROVIDER} at ${this.#options.baseUrl}`);
    }
    return response.json();
  }
}

/** The provider recorded alongside vectors this adapter produced. */
export const EMBEDDING_PROVIDER = "local-embedding";

export interface LocalEmbedderOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  /** How many components the model's vectors carry. `bge-small-en-v1.5` is 384. */
  readonly dimensions?: number;
}

/**
 * LMStudio's default port and the model `runtime.md` §2 names.
 *
 * "or equivalent" in that sentence is why the model is a default rather than a
 * constant: the vector's model version is stored with it, so a model change is
 * a legible projection rebuild rather than a silent mix of two vector spaces.
 */
const LOCAL_EMBEDDER_DEFAULTS = {
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "text-embedding-bge-small-en-v1.5",
  dimensions: 384,
} as const satisfies Required<LocalEmbedderOptions>;

/**
 * The vectors in an embeddings response, ordered by the endpoint's own `index`.
 *
 * Throws on a short or malformed response rather than padding it. A caller
 * cannot tell a zero vector from a missing one, and candidate generation
 * degrading silently to "no vector candidates" looks exactly like a resolution
 * that considered the graph and found nothing — which is a decision, not an
 * outage.
 */
function readEmbeddings(response: unknown, expected: number, model: string): Float32Array[] {
  const data = (response as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new Error(
      `embedding with ${model}: expected ${expected} vectors, got ${describeLength(data)}`,
    );
  }
  return [...data]
    .sort((left, right) => indexOf(left) - indexOf(right))
    .map((entry, position) => toVector(entry, position, model));
}

function describeLength(data: unknown): string {
  return Array.isArray(data) ? String(data.length) : "a malformed response";
}

function indexOf(entry: unknown): number {
  const index = (entry as { index?: unknown }).index;
  return typeof index === "number" ? index : 0;
}

function toVector(entry: unknown, position: number, model: string): Float32Array {
  const embedding = (entry as { embedding?: unknown }).embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(`embedding with ${model}: vector ${position} is missing or empty`);
  }
  return Float32Array.from(embedding as number[]);
}
