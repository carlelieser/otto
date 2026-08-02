import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureExtraction } from "../../src/application/pipeline/extract-capture.js";
import { deriveProposalId } from "../../src/capture/capture-identity.js";
import { createStorage, type Storage } from "../../src/composition-root.js";
import { InMemoryExtractor } from "../../src/infrastructure/llm/in-memory-extractor.js";
import type { Extraction, Extractor } from "../../src/ports/extractor.js";
import { A_CAPTURE_ID, aCapture } from "../support/builders.js";

/**
 * Extraction as a pipeline stage: what it records, and what it does *not* do
 * twice.
 *
 * The storage here is real SQLite in `:memory:` rather than a fake, per
 * `add.md` §9 — the only fake in this file is the extractor, which is the port
 * that reaches a model and therefore the one where a stub is load-bearing.
 */

const CAPTURED_AT = "2026-08-01T09:00:00.000Z";
const A_NOTE = "Coffee with Sarah about the Helios rollout.";

const SARAH = {
  text: "Sarah",
  entity_type: "Person",
  confidence: 0.9,
  fields: [{ field: "employer", value: "Globex" }],
};

const HELIOS = {
  text: "Helios rollout",
  entity_type: "Project",
  confidence: 0.8,
  fields: [{ field: "status", value: "active" }],
};

function anExtractor(mentions: unknown[] = [SARAH, HELIOS]): InMemoryExtractor {
  return new InMemoryExtractor({ responses: [[A_NOTE, { mentions }]] });
}

/** A clock that does not move, so a test asserting ids is not asserting time. */
const A_CLOCK = () => "2026-08-01T09:00:02.000Z";

describe("extracting a Capture", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createStorage();
    return () => storage.close();
  });

  function extractionWith(extractor: Extractor): CaptureExtraction {
    return new CaptureExtraction(extractor, storage.proposals, A_CLOCK);
  }

  it("records one Proposal per Mention", async () => {
    const proposals = await extractionWith(anExtractor()).extract(aCapture({ rawText: A_NOTE }));

    expect(proposals.map(({ mention }) => mention.text)).toEqual(["Sarah", "Helios rollout"]);
  });

  it("carries the claimed field values through to the store", async () => {
    const [sarah] = await extractionWith(anExtractor()).extract(aCapture({ rawText: A_NOTE }));

    expect(sarah!.mention.fields).toEqual([{ field: "employer", value: "Globex" }]);
  });

  /**
   * `runtime.md` §3, and the half of it that makes re-extraction possible: the
   * provider and model version are in the hash, so a better model produces new
   * Proposals rather than colliding with the old ones.
   */
  it("derives `proposal_id` from the Capture, stage, provider, model, and ordinal", async () => {
    const proposals = await extractionWith(anExtractor()).extract(aCapture({ rawText: A_NOTE }));

    expect(proposals.map(({ proposalId }) => proposalId)).toEqual(
      [0, 1].map((ordinal) =>
        deriveProposalId({
          captureId: A_CAPTURE_ID,
          stage: "extraction",
          provider: "in-memory",
          modelVersion: "canned",
          ordinal,
        }),
      ),
    );
  });

  it("records the provider and model version on everything produced", async () => {
    const proposals = await extractionWith(anExtractor()).extract(aCapture({ rawText: A_NOTE }));

    for (const proposal of proposals) {
      expect(proposal).toMatchObject({ provider: "in-memory", modelVersion: "canned" });
    }
  });

  describe("resumability", () => {
    /**
     * The slice's stated property: a crash *after* extraction resumes at the
     * next stage rather than re-invoking the extractor. This is the test that
     * the resumption check is the Proposals themselves and not a hope.
     */
    it("does not call the extractor again for a Capture that already has Proposals", async () => {
      const capture = aCapture({ rawText: A_NOTE });
      const extractor = anExtractor();
      const extract = vi.spyOn(extractor, "extract");
      const stage = extractionWith(extractor);

      await stage.extract(capture);
      await stage.extract(capture);

      expect(extract).toHaveBeenCalledTimes(1);
    });

    it("returns the recorded Proposals on the second run", async () => {
      const capture = aCapture({ rawText: A_NOTE });
      const stage = extractionWith(anExtractor());

      const first = await stage.extract(capture);
      const second = await stage.extract(capture);

      expect(second).toEqual(first);
    });

    /**
     * A crash *mid*-extraction leaves a Capture with no Proposals, which the
     * worker picks up on restart. The two halves are one rule read from either
     * side, and this is the side that must still call the model.
     */
    it("extracts a Capture whose extraction never completed", async () => {
      const capture = aCapture({ rawText: A_NOTE });
      const failing = {
        extract: vi.fn<Extractor["extract"]>().mockRejectedValue(new Error("crash")),
      };

      await expect(extractionWith(failing).extract(capture)).rejects.toThrow("crash");
      const recovered = await extractionWith(anExtractor()).extract(capture);

      expect(recovered).toHaveLength(2);
    });

    /**
     * A retry under the same model is a no-op because the ids collide, which is
     * `runtime.md` §3's first half. Checked at the store rather than only at the
     * stage, since the stage's own check would hide a store that duplicated.
     */
    it("stores one Proposal per Mention however often extraction is retried", async () => {
      const capture = aCapture({ rawText: A_NOTE });
      const stage = extractionWith(anExtractor());

      await stage.extract(capture);
      await storage.proposals.put(await storage.proposals.forCapture(A_CAPTURE_ID));

      expect(await storage.proposals.forCapture(A_CAPTURE_ID)).toHaveLength(2);
    });
  });

  describe("a note with no extractable entity", () => {
    /**
     * A valid outcome that must not produce a spurious Proposal (`qa.md` §6.2).
     */
    it("records no Proposals", async () => {
      const proposals = await extractionWith(anExtractor([])).extract(
        aCapture({ rawText: A_NOTE }),
      );

      expect(proposals).toEqual([]);
    });

    /**
     * The cost of asking the store rather than tracking a status flag, stated
     * as a test rather than discovered later: a Capture that legitimately
     * yielded nothing is indistinguishable from one that never ran, so it is
     * re-extracted. That is affordable — extraction is deterministic at
     * temperature 0, so the second run produces the same nothing — and the
     * alternative is the status column `add.md` §4 avoids.
     */
    it("re-extracts it, because no Proposals is also what an unrun Capture looks like", async () => {
      const capture = aCapture({ rawText: A_NOTE });
      const extractor = anExtractor([]);
      const extract = vi.spyOn(extractor, "extract");
      const stage = extractionWith(extractor);

      await stage.extract(capture);
      await stage.extract(capture);

      expect(extract).toHaveBeenCalledTimes(2);
    });
  });

  describe("what the extractor is given", () => {
    it("gives it the normalised text and the Capture timestamp, and nothing else", async () => {
      const extractor = {
        extract: vi.fn<Extractor["extract"]>().mockResolvedValue(anEmptyExtraction()),
      };

      await extractionWith(extractor).extract(
        aCapture({ rawText: "  Coffee   with\nSarah. ", sourceTimestamp: CAPTURED_AT }),
      );

      expect(extractor.extract).toHaveBeenCalledWith({
        text: "Coffee with Sarah.",
        capturedAt: CAPTURED_AT,
      });
    });

    /**
     * The user has said the raw text was wrong, and extracting from what they
     * corrected is the point of correcting it (`add.md` §5.1). Slice 9 writes
     * the column; the read side is here because extraction is what reads it.
     */
    it("prefers a corrected transcript over the raw text", async () => {
      const extractor = {
        extract: vi.fn<Extractor["extract"]>().mockResolvedValue(anEmptyExtraction()),
      };

      await extractionWith(extractor).extract(
        aCapture({ rawText: "Coffee with Sara.", correctedText: "Coffee with Sarah." }),
      );

      expect(extractor.extract).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Coffee with Sarah." }),
      );
    });
  });
});

function anEmptyExtraction(): Extraction {
  return { mentions: [], violations: [], provider: "in-memory", modelVersion: "canned" };
}
