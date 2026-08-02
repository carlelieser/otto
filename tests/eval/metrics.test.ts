import { describe, expect, it } from "vitest";
import type { Extraction } from "../../src/ports/extractor.js";
import type { EvalCase } from "./corpus/case.js";
import { summarise } from "./metrics.js";
import { scoreCase } from "./score.js";

/**
 * The metric arithmetic, tested deterministically.
 *
 * The measurement these feed cannot run in CI, which is exactly why this can: a
 * rate computed against the wrong denominator reports a number that looks
 * plausible and gates nothing, and nobody would find out until the gate was
 * being trusted.
 */

const A_CASE: EvalCase = {
  id: "one",
  covers: "ordinary",
  note: "Coffee with Sarah.",
  capturedAt: "2026-08-03T09:00:00.000Z",
  expected: [{ text: "Sarah", entityType: "Person" }],
};

function anExtraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    mentions: [{ text: "Sarah", entityType: "Person", fields: [], confidence: 0.9 }],
    violations: [],
    provider: "local",
    modelVersion: "test",
    ...overrides,
  };
}

function metricsFor(extraction: Extraction) {
  return summarise([scoreCase(A_CASE, extraction)], extraction.provider, extraction.modelVersion);
}

describe("the schema violation rate", () => {
  it("is zero when every emitted field was permitted", () => {
    const extraction = anExtraction({
      mentions: [
        {
          text: "Sarah",
          entityType: "Person",
          fields: [{ field: "employer", value: "Globex" }],
          confidence: 0.9,
        },
      ],
    });

    expect(metricsFor(extraction).schemaViolationRate).toBe(0);
  });

  /**
   * `qa.md` §6.1 names the metric as a rate of "fields not in `schema.md`", so
   * the denominator is emitted fields rather than cases. Three kept fields and
   * one drop is 25%, not "one violation for this note" — dividing by cases
   * gives a number that can exceed 1 while the floor's bar is written as a
   * fraction.
   */
  it("is the fraction of emitted fields that were dropped, not a count per case", () => {
    const extraction = anExtraction({
      mentions: [
        {
          text: "Sarah",
          entityType: "Person",
          fields: [
            { field: "employer", value: "Globex" },
            { field: "role", value: "engineer" },
            { field: "location", value: "Lisbon" },
          ],
          confidence: 0.9,
        },
      ],
      violations: [{ reason: "unknown_field", field: "shoe_size", entityType: "Person" }],
    });

    expect(metricsFor(extraction).schemaViolationRate).toBe(0.25);
  });

  /**
   * A model that produced nothing has a recall problem, not a schema one.
   * Reporting an empty denominator as 1 — the right answer for an accuracy —
   * would fail the zero-tolerance clause on a model that never emitted a field.
   */
  it("is zero rather than one when the model emitted no fields at all", () => {
    expect(metricsFor(anExtraction({ mentions: [] })).schemaViolationRate).toBe(0);
  });
});

describe("mean confidence", () => {
  /**
   * The input `qa.md` §6.3's degradation clause reads. It is what the model
   * *claimed*, not an accuracy — ADR-0006's argument is that the claim is a
   * token distribution rather than a probability.
   */
  it("averages the self-reported p(extraction) over returned mentions", () => {
    const extraction = anExtraction({
      mentions: [
        { text: "Sarah", entityType: "Person", fields: [], confidence: 0.9 },
        { text: "Helios", entityType: "Project", fields: [], confidence: 0.7 },
      ],
    });

    expect(metricsFor(extraction).meanConfidence).toBeCloseTo(0.8);
  });

  it("is zero when nothing was returned, since nothing was claimed", () => {
    expect(metricsFor(anExtraction({ mentions: [] })).meanConfidence).toBe(0);
  });
});

describe("mention recall and precision", () => {
  it("counts a found entity as recalled", () => {
    expect(metricsFor(anExtraction()).mentionRecall).toBe(1);
  });

  it("counts an invented entity against precision", () => {
    const extraction = anExtraction({
      mentions: [
        { text: "Sarah", entityType: "Person", fields: [], confidence: 0.9 },
        { text: "Nobody", entityType: "Person", fields: [], confidence: 0.4 },
      ],
    });

    expect(metricsFor(extraction).mentionPrecision).toBe(0.5);
  });

  /**
   * A note expecting nothing and receiving nothing is full precision, not a
   * `NaN` — the `no-extractable-entity` cases are a quarter of the degenerate
   * corpus and would otherwise poison every summary they appear in.
   */
  it("reports full precision for a note that correctly found nothing", () => {
    const empty: EvalCase = { ...A_CASE, id: "nothing", expected: [] };
    const scores = [scoreCase(empty, anExtraction({ mentions: [] }))];

    expect(summarise(scores, "local", "test").mentionPrecision).toBe(1);
  });
});
