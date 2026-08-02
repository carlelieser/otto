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
import { dispatch } from "../../src/interfaces/sidecar/dispatch.js";
import { sidecarMethods } from "../../src/interfaces/sidecar/methods.js";
import { FROM_START } from "../../src/ports/event-store.js";
import type { Capture } from "../../src/ports/capture-store.js";

const MISHEARD = "Coffee with Sara.";
const CORRECTED = "Coffee with Sarah.";

const SARA = { text: "Sara", entity_type: "Person", confidence: 0.9, fields: [] };
const SARAH = { text: "Sarah", entity_type: "Person", confidence: 0.9, fields: [] };

const AT = "2026-08-02T10:00:00.000Z";

function anExtractor() {
  return new InMemoryExtractor({
    responses: [
      [MISHEARD, { mentions: [SARA] }],
      [CORRECTED, { mentions: [SARAH] }],
    ],
  });
}

async function call(methods: ReturnType<typeof sidecarMethods>, method: string, params: unknown) {
  return dispatch(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), methods);
}

/**
 * The correction affordance over the transport, which is how the surface
 * reaches it (`qa.md` §7.6).
 *
 * Driven through `dispatch` rather than by calling the handler, so the test
 * covers the seam the host actually uses.
 */
describe("the sidecar's correction method", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createStorage();
    return () => storage.close();
  });

  function sidecar() {
    const extraction = createExtraction(storage, anExtractor(), () => AT);
    return sidecarMethods({
      ingestion: {} as never,
      transcriber: {} as never,
      extraction,
      captures: storage.captures,
      correction: createCorrection(storage, () => AT),
      reextraction: createReextraction(extraction, storage),
    });
  }

  async function aVoiceCapture(): Promise<Capture> {
    return createIngestion(storage, () => AT).ingest({
      source: "voice",
      rawText: MISHEARD,
      sourceTimestamp: "2026-08-01T09:00:00.000Z",
      transcriptionModel: "small.en",
    });
  }

  it("corrects a voice transcript in one call", async () => {
    const capture = await aVoiceCapture();

    const response = await call(sidecar(), "correctTranscript", {
      captureId: capture.captureId,
      correctedText: CORRECTED,
    });

    expect(response).toMatchObject({ result: { capture: { correctedText: CORRECTED } } });
  });

  it("appends CaptureTranscriptCorrected", async () => {
    const capture = await aVoiceCapture();

    await call(sidecar(), "correctTranscript", {
      captureId: capture.captureId,
      correctedText: CORRECTED,
    });

    const types = (await storage.events.readForward(FROM_START)).map((event) => event.type);
    expect(types).toContain(CAPTURE_TRANSCRIPT_CORRECTED);
  });

  /**
   * **The one case where re-extraction is automatic** (`runtime.md` §3, §5).
   * The user has explicitly said the input was wrong, so nothing further is
   * asked of them before Otto re-reads the note.
   */
  it("re-runs extraction for the corrected Capture without being asked", async () => {
    const capture = await aVoiceCapture();

    const response = await call(sidecar(), "correctTranscript", {
      captureId: capture.captureId,
      correctedText: CORRECTED,
    });

    expect(response).toMatchObject({
      result: { proposals: [{ mention: { text: "Sarah" } }] },
    });
  });

  it("reports nothing newly proposed when the re-run confirms current belief", async () => {
    const capture = await aVoiceCapture();
    await createExtraction(storage, anExtractor(), () => AT).extract(capture);

    const response = await call(sidecar(), "correctTranscript", {
      captureId: capture.captureId,
      correctedText: CORRECTED,
    });

    // The ids collide under the same model, so no Proposal is new and nothing
    // reaches the queue (`qa.md` §4.3).
    expect(response).toMatchObject({ result: { emerged: [] } });
  });

  /**
   * The Capture index is built from `captures` rather than folded from the log,
   * because no event carries a Capture's text. `reset` and a rebuild put it
   * back — but a correction is neither, so without reindexing here the
   * corrected transcript stays unsearchable until the next rebuild, and search
   * keeps returning the misheard text as though nothing happened.
   */
  it("makes the corrected text searchable rather than the misheard text", async () => {
    const capture = await aVoiceCapture();
    await storage.projections.reindexCaptures();

    await call(sidecar(), "correctTranscript", {
      captureId: capture.captureId,
      correctedText: CORRECTED,
    });

    expect(await storage.views.searchCaptures("Sarah")).toHaveLength(1);
    expect(await storage.views.searchCaptures("Sara")).toHaveLength(0);
  });

  it("refuses to correct a typed Capture", async () => {
    const typed = await createIngestion(storage, () => AT).ingest({
      source: "typed",
      rawText: CORRECTED,
      sourceTimestamp: "2026-08-01T09:00:00.000Z",
      transcriptionModel: null,
    });

    const response = await call(sidecar(), "correctTranscript", {
      captureId: typed.captureId,
      correctedText: MISHEARD,
    });

    expect(response).toMatchObject({ error: { message: /typed/i } });
  });

  it("requires a captureId and corrected text", async () => {
    const response = await call(sidecar(), "correctTranscript", { captureId: "cap-1" });

    expect(response).toMatchObject({ error: { message: /correctedText/ } });
  });
});

/**
 * **Test the absence of the affordance** (`qa.md` §7.6, PRD §6).
 *
 * A sidecar wired without a correction exposes no `correctTranscript` at all,
 * so a surface built against it has nothing to call. This is the transport-level
 * half of "typed Captures are not editable" — the stage-level half refuses a
 * typed Capture even when the method is present.
 */
describe("the correction method is absent when nothing is wired", () => {
  it("does not register correctTranscript without a correction", () => {
    const methods = sidecarMethods({ ingestion: {} as never, transcriber: {} as never });

    expect(Object.keys(methods)).not.toContain("correctTranscript");
  });
});
