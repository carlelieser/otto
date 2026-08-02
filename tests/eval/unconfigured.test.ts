import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExtractor,
  createExtraction,
  createStorage,
  type Storage,
} from "../../src/composition-root.js";
import { InMemoryExtractor } from "../../src/infrastructure/llm/in-memory-extractor.js";
import { LOCAL_PROVIDER } from "../../src/infrastructure/llm/local-extractor.js";
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

  it("builds an extractor rather than throwing", () => {
    expect(() => createExtractor()).not.toThrow();
  });

  /**
   * Local is the baseline Otto is built to run on, not a fallback entered on
   * failure — which is why the unconfigured path resolves to it directly rather
   * than to an error the caller has to handle.
   */
  it("defaults to the local path", async () => {
    const extractor = createExtractor();

    // The adapter is identified by what it records on its output, since that is
    // the property the rest of the system actually reads (ADR-0008).
    await expect(
      extractor.extract({ text: "anything", capturedAt: "2026-08-03T09:00:00.000Z" }),
    ).rejects.toThrow(new RegExp(LOCAL_PROVIDER));
  });

  /**
   * Removing a previously-configured provider must leave Otto functional rather
   * than stalled (`qa.md` §6.3). The "captures accumulate" state would be a
   * failure here, because nothing is unavailable — the user simply stopped
   * paying for an upgrade.
   */
  it("falls back to local when a configured key is removed", () => {
    process.env.OTTO_EXTRACTION_PROVIDER = "anthropic";

    expect(() => createExtractor()).not.toThrow();
  });

  it("falls back to local when the provider name is not one Otto has an adapter for", () => {
    process.env.OTTO_EXTRACTION_PROVIDER = "a-typo";

    expect(() => createExtractor()).not.toThrow();
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
