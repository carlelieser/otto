import { createHash } from "node:crypto";
import type { Embedder } from "../../ports/embedder.js";

/**
 * An `Embedder` producing deterministic vectors from text, so candidate
 * generation runs with no model at all.
 *
 * This is one of the four ports where a second adapter *is* load-bearing
 * (`add.md` §9): there is no offline mode for a model, so without a stub
 * nothing downstream of embedding is testable and the eval set cannot run in CI
 * on every commit.
 *
 * ## What it does and does not stand in for
 *
 * The vectors are a hash of the text, unit-normalised. That makes them
 * **deterministic and self-consistent** — one text always embeds to one vector,
 * and identical texts are identical vectors at distance 0 — which is what the
 * machinery under test actually needs: that a search returns the nearest rows
 * in the right order, that the `BLOB` round-trips, that the `limit` is honoured.
 *
 * It emphatically does **not** stand in for semantic nearness. "the Helios
 * rollout" and "the website relaunch" are unrelated vectors here and close ones
 * under a real model, so **no test may assert that a semantically similar name
 * is retrieved through this stub.** That is a measurement against a real model
 * on a real corpus, and `runtime.md` §4.2 already names it: the storage spike
 * measured the index and not retrieval quality, which stays an eval-set
 * question (`qa.md` §6).
 *
 * Written down because the failure mode is a test that passes for the wrong
 * reason — a fixture tuned until the hash happens to put two strings near each
 * other proves nothing about the model that ships.
 */
export class InMemoryEmbedder implements Embedder {
  readonly #dimensions: number;
  readonly #modelVersion: string;

  constructor(options: InMemoryEmbedderOptions = {}) {
    this.#dimensions = options.dimensions ?? IN_MEMORY_DIMENSIONS;
    this.#modelVersion = options.modelVersion ?? IN_MEMORY_EMBEDDING_MODEL;
  }

  get dimensions(): number {
    return this.#dimensions;
  }

  get modelVersion(): string {
    return this.#modelVersion;
  }

  async embed(text: string): Promise<Float32Array> {
    return hashVector(text, this.#dimensions);
  }

  async embedAll(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return texts.map((text) => hashVector(text, this.#dimensions));
  }
}

export interface InMemoryEmbedderOptions {
  readonly dimensions?: number;
  readonly modelVersion?: string;
}

/** `bge-small-en-v1.5`'s width, so the stub exercises the real column shape. */
const IN_MEMORY_DIMENSIONS = 384;

/**
 * Deliberately not the real model's name.
 *
 * The vector's model version is stored beside it so that a model change is a
 * legible rebuild rather than a silent mix of two vector spaces. A stub
 * claiming to be `bge-small-en-v1.5` would put unattributable rows in a
 * projection whose whole purpose is to say which model produced what.
 */
export const IN_MEMORY_EMBEDDING_MODEL = "in-memory-hash";

/**
 * A unit vector derived from `text` by hashing.
 *
 * SHA-256 expanded by counter until the requested width is filled, then
 * normalised — normalised because cosine distance is undefined at zero
 * magnitude and because unit vectors keep the distances in a range that reads
 * like the real model's.
 */
function hashVector(text: string, dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = componentAt(text, index);
  }
  return normalise(vector);
}

/** One component, in [-1, 1], from the hash of the text and the position. */
function componentAt(text: string, index: number): number {
  const digest = createHash("sha256").update(`${index}:${text}`).digest();
  return digest.readUInt16BE(0) / 32768 - 1;
}

function normalise(vector: Float32Array): Float32Array {
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}
