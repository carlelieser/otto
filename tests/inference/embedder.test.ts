import { describe, expect, it } from "vitest";
import {
  IN_MEMORY_EMBEDDING_MODEL,
  InMemoryEmbedder,
} from "../../src/infrastructure/embedding/in-memory-embedder.js";
import { LocalEmbedder } from "../../src/infrastructure/embedding/local-embedder.js";
import { cosineDistance } from "../../src/infrastructure/persistence/vector-distance.js";

describe("the in-memory embedder", () => {
  const embedder = new InMemoryEmbedder();

  it("produces vectors of the declared width", async () => {
    const vector = await embedder.embed("Sarah Chen");

    expect(vector).toHaveLength(embedder.dimensions);
  });

  /** One text always embeds to one vector: this is what makes it a stub rather than noise. */
  it("is deterministic", async () => {
    expect(await embedder.embed("Sarah Chen")).toEqual(await embedder.embed("Sarah Chen"));
  });

  it("puts identical texts at distance zero", async () => {
    const [left, right] = await embedder.embedAll(["Helios", "Helios"]);

    expect(cosineDistance(left!, right!)).toBeCloseTo(0);
  });

  it("gives different texts different vectors", async () => {
    const [helios, atlas] = await embedder.embedAll(["Helios", "Atlas"]);

    expect(cosineDistance(helios!, atlas!)).toBeGreaterThan(0);
  });

  it("returns vectors in the order the texts were given", async () => {
    const texts = ["one", "two", "three"];
    const batch = await embedder.embedAll(texts);

    for (const [index, text] of texts.entries()) {
      expect(batch[index]).toEqual(await embedder.embed(text));
    }
  });

  it("produces unit vectors, so cosine distance is defined", async () => {
    const vector = await embedder.embed("Sarah");
    const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));

    expect(magnitude).toBeCloseTo(1);
  });

  it("returns nothing for no texts rather than calling out", async () => {
    expect(await embedder.embedAll([])).toEqual([]);
  });

  /**
   * The stub names itself, and that is deliberate: a vector's model version is
   * stored beside it so a model change is a legible rebuild rather than a
   * silent mix of two vector spaces.
   */
  it("does not claim to be the real model", () => {
    expect(embedder.modelVersion).toBe(IN_MEMORY_EMBEDDING_MODEL);
    expect(embedder.modelVersion).not.toContain("bge");
  });
});

/** A `fetch` returning one canned response, so the adapter is testable offline. */
function respondingWith(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("the local embedder", () => {
  it("reads the vectors out of a well-formed response", async () => {
    const embedder = new LocalEmbedder(
      { dimensions: 3 },
      respondingWith({ data: [{ index: 0, embedding: [1, 0, 0] }] }),
    );

    expect(await embedder.embed("Sarah")).toEqual(Float32Array.from([1, 0, 0]));
  });

  /**
   * The order is the contract: the caller pairs each vector with the entity it
   * embedded, so a reordered response would attach every entity's vector to a
   * different entity. The endpoint returns an `index` for exactly this reason.
   */
  it("orders vectors by the endpoint's index rather than by arrival", async () => {
    const embedder = new LocalEmbedder(
      { dimensions: 2 },
      respondingWith({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    );

    const [first, second] = await embedder.embedAll(["a", "b"]);
    expect(first).toEqual(Float32Array.from([1, 0]));
    expect(second).toEqual(Float32Array.from([0, 1]));
  });

  /**
   * A caller cannot tell a zero vector from a failed call, and candidate
   * generation degrading silently to "no vector candidates" looks exactly like
   * a resolution that considered the graph and found nothing.
   */
  it("throws on a response with fewer vectors than texts", async () => {
    const embedder = new LocalEmbedder({}, respondingWith({ data: [] }));

    await expect(embedder.embedAll(["a", "b"])).rejects.toThrow(/expected 2 vectors/);
  });

  it("throws on a malformed response rather than returning a default", async () => {
    const embedder = new LocalEmbedder({}, respondingWith({ error: "no model loaded" }));

    await expect(embedder.embed("Sarah")).rejects.toThrow(/expected 1 vectors/);
  });

  it("throws on an empty vector", async () => {
    const embedder = new LocalEmbedder({}, respondingWith({ data: [{ index: 0, embedding: [] }] }));

    await expect(embedder.embed("Sarah")).rejects.toThrow(/missing or empty/);
  });

  it("names the provider and the endpoint when the runtime refuses", async () => {
    const embedder = new LocalEmbedder({}, respondingWith({ error: "down" }, 500));

    await expect(embedder.embed("Sarah")).rejects.toThrow(/local-embedding/);
  });

  it("does not call out for an empty batch", async () => {
    const failing = (() => {
      throw new Error("should not have been called");
    }) as unknown as typeof fetch;

    expect(await new LocalEmbedder({}, failing).embedAll([])).toEqual([]);
  });

  it("reports the model it was configured with", () => {
    const embedder = new LocalEmbedder({ model: "bge-large", dimensions: 1024 });

    expect(embedder.modelVersion).toBe("bge-large");
    expect(embedder.dimensions).toBe(1024);
  });
});
