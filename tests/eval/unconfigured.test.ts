import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExtractor,
  createExtraction,
  createStorage,
  type Storage,
} from "../../src/composition-root.js";
import {
  AnthropicExtractor,
  ANTHROPIC_PROVIDER,
} from "../../src/infrastructure/llm/anthropic-extractor.js";
import { InMemoryExtractor } from "../../src/infrastructure/llm/in-memory-extractor.js";
import { LocalExtractor } from "../../src/infrastructure/llm/local-extractor.js";
import { aCapture } from "../support/builders.js";
import { EVAL_CORPUS } from "./corpus/notes.js";
import { runCorpus } from "./run-corpus.js";

/**
 * **The unconfigured state is the primary configuration, not an edge case**
 * (`qa.md` §6.3, ADR-0016).
 *
 * A test that only passes with a cloud key configured is testing something no
 * default user experiences, so this file asserts the opposite: that everything
 * works with no credentials present anywhere. It runs in the default suite, on
 * a clean checkout, with no network.
 */

/** Every credential Otto reads, cleared for the duration of a test. */
const PROVIDER_VARIABLES = [
  "OTTO_EXTRACTION_PROVIDER",
  "OTTO_LOCAL_BASE_URL",
  "OTTO_LOCAL_MODEL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

describe("with no provider configured", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of PROVIDER_VARIABLES) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /**
   * Every assertion below names the adapter `createExtractor` returned, rather
   * than checking that construction did not throw.
   *
   * That is the difference between this file passing and this file meaning
   * something. A factory handing back a cloud adapter holding an empty key
   * satisfies "does not throw" and then fails on the first note with a 401 —
   * the stalled state `qa.md` §6.3 says must not happen, reached by the one
   * route a looser assertion cannot see. Checked by construction rather than by
   * a call, because calling a cloud adapter would put a request to a real
   * vendor in the default suite.
   */

  it("builds an extractor rather than throwing", () => {
    expect(() => createExtractor()).not.toThrow();
  });

  /**
   * Local is the baseline Otto is built to run on, not a fallback entered on
   * failure — which is why the unconfigured path resolves to it directly rather
   * than to an error the caller has to handle.
   */
  it("defaults to the local path", () => {
    expect(createExtractor()).toBeInstanceOf(LocalExtractor);
  });

  /**
   * Removing a previously-configured provider must leave Otto functional rather
   * than stalled (`qa.md` §6.3). The "captures accumulate" state would be a
   * failure here, because nothing is unavailable — the user simply stopped
   * paying for an upgrade.
   */
  it("falls back to local when a configured key is removed", () => {
    process.env.OTTO_EXTRACTION_PROVIDER = ANTHROPIC_PROVIDER;

    expect(createExtractor()).toBeInstanceOf(LocalExtractor);
  });

  it("falls back to local when the provider name is not one Otto has an adapter for", () => {
    process.env.OTTO_EXTRACTION_PROVIDER = "a-typo";

    expect(createExtractor()).toBeInstanceOf(LocalExtractor);
  });

  /**
   * The other half of the same rule: a provider that *is* configured is the one
   * that runs. A fallback that fired regardless of the key would pass every
   * test above and quietly ignore what the user paid for.
   *
   * Checked by construction rather than by a call, because calling would put a
   * request to a real vendor inside the default suite — and this file's whole
   * subject is what happens with no credentials, which is not a thing to prove
   * by spending someone's.
   */
  it("uses the configured provider when its key is present", () => {
    process.env.OTTO_EXTRACTION_PROVIDER = ANTHROPIC_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "sk-not-a-real-key";

    expect(createExtractor()).toBeInstanceOf(AnthropicExtractor);
  });

  it("returns the local adapter, not a keyless cloud one, when the key is absent", () => {
    process.env.OTTO_EXTRACTION_PROVIDER = ANTHROPIC_PROVIDER;

    expect(createExtractor()).toBeInstanceOf(LocalExtractor);
  });

  describe("the full pipeline", () => {
    let storage: Storage;

    beforeEach(() => {
      storage = createStorage();
      return () => storage.close();
    });

    /**
     * The slice's stated exit condition, minus the model: a Capture produces
     * Mentions and field values with no credentials configured anywhere. The
     * in-memory adapter stands in for the local one here, because CI has no
     * model — `add.md` §9 is explicit that this is the case where a second
     * adapter is load-bearing.
     */
    it("runs a Capture through extraction green", async () => {
      const note = "Coffee with Sarah.";
      const extractor = new InMemoryExtractor({
        responses: [
          [
            note,
            { mentions: [{ text: "Sarah", entity_type: "Person", confidence: 0.9, fields: [] }] },
          ],
        ],
      });

      const proposals = await createExtraction(storage, extractor).extract(
        aCapture({ rawText: note }),
      );

      expect(proposals.map(({ mention }) => mention.text)).toEqual(["Sarah"]);
    });
  });

  /**
   * The corpus itself runs in CI on every commit against the in-memory adapters
   * (the slice's "Done when"). Against a stub that knows no answers the metrics
   * are floors rather than quality signals — what this proves is that the
   * harness runs end to end without a model, which is what lets the same code
   * measure a real one on demand.
   */
  it("runs the whole corpus through the harness without a model", async () => {
    const { scores, metrics } = await runCorpus(new InMemoryExtractor());

    expect(scores).toHaveLength(EVAL_CORPUS.length);
    expect(metrics.provider).toBe("in-memory");
    // A stub that invents nothing cannot violate the schema, and that is the
    // zero-tolerance metric's floor rather than a result about a model.
    expect(metrics.schemaViolationRate).toBe(0);
  });
});
