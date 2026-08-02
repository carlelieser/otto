import { beforeEach, describe, expect, it } from "vitest";
import {
  createCorrection,
  createExtraction,
  createIngestion,
  createReextraction,
  createStorage,
  type Storage,
} from "../../src/composition-root.js";
import { CAPTURE_TRANSCRIPT_CORRECTED } from "../../src/domain/events/capture-corrected.js";
import { InMemoryExtractor } from "../../src/infrastructure/llm/in-memory-extractor.js";
import { FROM_START } from "../../src/ports/event-store.js";
import type { Capture } from "../../src/ports/capture-store.js";

/**
 * **Slice 9's "Done when", end to end** (`qa.md` §7.6).
 *
 * A misheard name in a voice note is fixed in one step; both transcripts stay
 * readable and the raw one is provably unmodified; provenance names the
 * corrected text as what produced the fact.
 */

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

const AT = "2026-08-02T10:00:00.000Z";

function anExtractor(modelVersion = "canned") {
  return new InMemoryExtractor({
    responses: [
      [MISHEARD, { mentions: [SARA] }],
      [CORRECTED, { mentions: [SARAH] }],
    ],
    modelVersion,
  });
}

describe("a misheard name is fixable in one step", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createStorage();
    return () => storage.close();
  });

  /** The note as it arrives: transcribed, extracted, and wrong. */
  async function aMisheardNote(): Promise<Capture> {
    const capture = await createIngestion(storage, () => AT).ingest({
      source: "voice",
      rawText: MISHEARD,
      sourceTimestamp: "2026-08-01T09:00:00.000Z",
      transcriptionModel: "small.en",
    });
    await createExtraction(storage, anExtractor(), () => AT).extract(capture);
    return capture;
  }

  /** One step: correct, and Otto re-reads the note. */
  async function correcting(capture: Capture, modelVersion = "canned") {
    const extraction = createExtraction(storage, anExtractor(modelVersion), () => AT);
    const corrected = await createCorrection(storage, () => AT).correct(
      capture.captureId,
      CORRECTED,
    );
    return {
      capture: corrected,
      ...(await createReextraction(extraction, storage).reextract(corrected)),
    };
  }

  it("extracts the corrected name after the correction", async () => {
    const { proposals } = await correcting(await aMisheardNote());

    expect(proposals.map(({ mention }) => mention.text)).toEqual(["Sarah"]);
  });

  it("keeps both transcripts readable", async () => {
    const capture = await aMisheardNote();

    const { capture: corrected } = await correcting(capture);

    expect(corrected.rawText).toBe(MISHEARD);
    expect(corrected.correctedText).toBe(CORRECTED);
  });

  /**
   * The immutability rule, checked against the row rather than against the
   * port: `content_hash` covers `raw_text`, so an unchanged hash is proof the
   * original was not rewritten under the correction.
   */
  it("leaves the raw transcript and its hash provably unmodified", async () => {
    const capture = await aMisheardNote();

    await correcting(capture);

    const stored = await storage.captures.get(capture.captureId);
    expect(stored?.rawText).toBe(capture.rawText);
    expect(stored?.contentHash).toBe(capture.contentHash);
  });

  /**
   * **Provenance names the corrected text** as what produced the fact.
   *
   * Provenance names a Capture, and the text behind that Capture is whatever
   * the read path resolves it to. So this asserts against the two surfaces that
   * actually resolve it — extraction's request, and the Capture search index —
   * rather than re-implementing the `correctedText ?? rawText` fallback in the
   * test, which would assert only that the test agrees with itself.
   */
  it("names the corrected text as what a re-extracted Proposal came from", async () => {
    const capture = await aMisheardNote();
    const asked: string[] = [];
    const watching = {
      extract: (request: { text: string }) => {
        asked.push(request.text);
        return anExtractor("canned-v2").extract(request as never);
      },
    };

    await createCorrection(storage, () => AT).correct(capture.captureId, CORRECTED);
    const extraction = createExtraction(storage, watching as never, () => AT);
    const { proposals } = await createReextraction(extraction, storage).reextract(
      (await storage.captures.get(capture.captureId))!,
    );

    // What the model was actually handed, and what the Proposal traces back to.
    expect(asked).toEqual([CORRECTED]);
    expect(proposals[0]!.captureId).toBe(capture.captureId);
    expect(await storage.views.searchCaptures("Sarah")).toHaveLength(1);
  });

  /** Nothing was overwritten: both events stand, in the order they happened. */
  it("keeps the whole history of the Capture on the log", async () => {
    const capture = await aMisheardNote();

    await correcting(capture);

    const events = await storage.events.readForward(FROM_START);
    const forCapture = events.filter((event) => event.aggregate.id === capture.captureId);
    expect(forCapture.map((event) => event.type)).toEqual([
      "CaptureIngested",
      CAPTURE_TRANSCRIPT_CORRECTED,
    ]);
  });

  /**
   * `qa.md` §4.3: re-extraction that confirms existing belief produces no queue
   * entries. Under the same model the ids collide, so nothing is new and the
   * user is not asked to re-confirm what Otto already believes.
   */
  it("proposes nothing new when the re-run confirms existing belief", async () => {
    const { emerged } = await correcting(await aMisheardNote());

    expect(emerged).toEqual([]);
  });
});
