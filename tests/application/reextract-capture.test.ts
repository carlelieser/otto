import { beforeEach, describe, expect, it } from "vitest";
import { CaptureExtraction } from "../../src/application/pipeline/extract-capture.js";
import { CaptureReextraction } from "../../src/application/pipeline/reextract-capture.js";
import { createStorage, type Storage } from "../../src/composition-root.js";
import { InMemoryExtractor } from "../../src/infrastructure/llm/in-memory-extractor.js";
import type { Extractor } from "../../src/ports/extractor.js";
import type { Capture } from "../../src/ports/capture-store.js";
import { aCapture } from "../support/builders.js";

const MISHEARD = "Coffee with Sara about the Helios rollout.";
const CORRECTED = "Coffee with Sarah about the Helios rollout.";

const SARA = {
  text: "Sara",
  entity_type: "Person",
  confidence: 0.9,
  fields: [{ field: "employer", value: "Globex" }],
};

const SARAH = {
  text: "Sarah",
  entity_type: "Person",
  confidence: 0.9,
  fields: [{ field: "employer", value: "Globex" }],
};

const A_CLOCK = () => "2026-08-02T10:00:00.000Z";

/** An extractor that answers both texts, so a re-run reads what changed. */
function anExtractor(modelVersion = "canned"): InMemoryExtractor {
  return new InMemoryExtractor({
    responses: [
      [MISHEARD, { mentions: [SARA] }],
      [CORRECTED, { mentions: [SARAH] }],
    ],
    modelVersion,
  });
}

/** The Capture as it stands after a correction: both texts present. */
function aCorrectedCapture(): Capture {
  return aCapture({ source: "voice", rawText: MISHEARD, correctedText: CORRECTED });
}

describe("re-extraction reads the corrected text", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createStorage();
    return () => storage.close();
  });

  function reextractionWith(extractor: Extractor): CaptureReextraction {
    return new CaptureReextraction(
      new CaptureExtraction(extractor, storage.proposals, A_CLOCK),
      storage.proposals,
    );
  }

  /**
   * The whole point of the slice: the misheard name is gone from what Otto
   * extracts, because the corrected text is what Extraction read.
   */
  it("extracts the corrected name rather than the misheard one", async () => {
    const proposals = await reextractionWith(anExtractor()).reextract(aCorrectedCapture());

    expect(proposals.map(({ mention }) => mention.text)).toEqual(["Sarah"]);
  });

  /**
   * `extract` short-circuits on a Capture that already has Proposals, which is
   * the resumability guarantee. Re-extraction has to get past it — the model is
   * called again, against the corrected text, rather than the recorded
   * Proposals being handed back untouched.
   */
  it("calls the model again for a Capture that already has Proposals", async () => {
    const extraction = new CaptureExtraction(anExtractor(), storage.proposals, A_CLOCK);
    const capture = aCorrectedCapture();
    await extraction.extract({ ...capture, correctedText: null });

    const asked: string[] = [];
    const watching = new CaptureExtraction(
      { extract: (request) => (asked.push(request.text), anExtractor().extract(request)) },
      storage.proposals,
      A_CLOCK,
    );
    await new CaptureReextraction(watching, storage.proposals).reextract(capture);

    expect(asked).toEqual([CORRECTED]);
  });

  /**
   * **The id derivation excludes the text, and this is what that costs.**
   *
   * `runtime.md` §3 derives a proposal id from the Capture, stage, model, and
   * ordinal — deliberately not from what was extracted — so the corrected
   * text's first Mention collides with the misheard text's first Mention, and
   * the store no-ops rather than overwriting.
   *
   * So under the same model a correction does **not** replace the recorded
   * Proposal. What updates the entity is the differ re-running against the
   * corrected claim, not a new Proposal id; a new id is what a *better model*
   * buys. Asserting this rather than hiding it keeps the next reader from
   * "fixing" the collision by hashing the text in, which would make every retry
   * a fresh Proposal and undo §3's idempotency.
   */
  it("keeps the recorded Proposal under the same model, ids having collided", async () => {
    const extraction = new CaptureExtraction(anExtractor(), storage.proposals, A_CLOCK);
    const capture = aCorrectedCapture();
    await extraction.extract({ ...capture, correctedText: null });

    await new CaptureReextraction(extraction, storage.proposals).reextract(capture);

    const stored = await storage.proposals.forCapture(capture.captureId);
    expect(stored.map(({ mention }) => mention.text)).toEqual(["Sara"]);
  });
});

/**
 * `qa.md` §4.3 and `runtime.md` §3, and the pair that pulls in opposite
 * directions. **A test asserting only the first would pass on an implementation
 * that hashed away the model version**, which is the bug §3 is written to
 * prevent — so both are here and neither is optional.
 */
describe("re-extraction under the id derivation", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createStorage();
    return () => storage.close();
  });

  function reextractionWith(extractor: Extractor): CaptureReextraction {
    return new CaptureReextraction(
      new CaptureExtraction(extractor, storage.proposals, A_CLOCK),
      storage.proposals,
    );
  }

  it("produces identical proposal ids under the same model", async () => {
    const capture = aCorrectedCapture();

    const first = await reextractionWith(anExtractor()).reextract(capture);
    const second = await reextractionWith(anExtractor()).reextract(capture);

    expect(second.map((proposal) => proposal.proposalId)).toEqual(
      first.map((proposal) => proposal.proposalId),
    );
  });

  it("produces new proposal ids under a different model version", async () => {
    const capture = aCorrectedCapture();

    const first = await reextractionWith(anExtractor("canned")).reextract(capture);
    const better = await reextractionWith(anExtractor("canned-v2")).reextract(capture);

    expect(better.map((proposal) => proposal.proposalId)).not.toEqual(
      first.map((proposal) => proposal.proposalId),
    );
  });

  /**
   * `qa.md` §4.3: a re-extracted Proposal matching current state closes
   * silently rather than appearing in the queue. Under the same model the ids
   * collide, so nothing new emerged and there is nothing to queue.
   */
  it("finds nothing new when a re-run confirms what was already extracted", async () => {
    const capture = aCorrectedCapture();
    await reextractionWith(anExtractor()).reextract(capture);

    expect(await reextractionWith(anExtractor()).emerged(capture)).toEqual([]);
  });

  /** The other half: a different model version says something new. */
  it("finds every Proposal new under a different model version", async () => {
    const capture = aCorrectedCapture();
    await reextractionWith(anExtractor("canned")).reextract(capture);

    const emerged = await reextractionWith(anExtractor("canned-v2")).emerged(capture);

    expect(emerged.map((proposal) => proposal.mention.text)).toEqual(["Sarah"]);
  });

  /**
   * The new ids arrive as **ordinary Proposals subject to ordinary triage**
   * rather than as a special class. Both sets stay stored against the Capture:
   * nothing deletes the old ones, because a Proposal is a claim that was made
   * and the record of what Otto considered is not rewritten by a better model.
   */
  it("keeps both models' Proposals against the Capture", async () => {
    const capture = aCorrectedCapture();
    await reextractionWith(anExtractor("canned")).reextract(capture);
    await reextractionWith(anExtractor("canned-v2")).reextract(capture);

    const stored = await storage.proposals.forCapture(capture.captureId);

    expect(stored.map((proposal) => proposal.modelVersion).sort()).toEqual(["canned", "canned-v2"]);
  });
});
