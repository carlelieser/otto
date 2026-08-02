import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExtraction, createStorage, type Storage } from "../../src/composition-root.js";
import { InMemoryExtractor } from "../../src/infrastructure/llm/in-memory-extractor.js";
import { dispatch } from "../../src/interfaces/sidecar/dispatch.js";
import { sidecarMethods } from "../../src/interfaces/sidecar/methods.js";
import type { Extractor } from "../../src/ports/extractor.js";
import { A_CAPTURE_ID, aCapture } from "../support/builders.js";

/**
 * Extraction over the transport, which is how the host reaches it.
 *
 * Driven through `dispatch` rather than by calling the handler, so the test
 * covers the seam the host actually uses — a method that works when called
 * directly and is not registered is a method the host cannot reach.
 */

const A_NOTE = "Coffee with Sarah.";

const SARAH = { text: "Sarah", entity_type: "Person", confidence: 0.9, fields: [] };

async function call(methods: ReturnType<typeof sidecarMethods>, params: unknown) {
  const request = { jsonrpc: "2.0", id: 1, method: "extractCapture", params };
  return dispatch(JSON.stringify(request), methods);
}

describe("the sidecar's extraction method", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createStorage();
    return () => storage.close();
  });

  function sidecarWith(extractor: Extractor) {
    return sidecarMethods({
      ingestion: {} as never,
      transcriber: {} as never,
      extraction: createExtraction(storage, extractor),
      captures: storage.captures,
    });
  }

  const anExtractor = () => new InMemoryExtractor({ responses: [[A_NOTE, { mentions: [SARAH] }]] });

  it("returns the Proposals for a stored Capture", async () => {
    await storage.captures.put(aCapture({ rawText: A_NOTE }));

    const response = await call(sidecarWith(anExtractor()), { captureId: A_CAPTURE_ID });

    expect(response).toMatchObject({
      result: [expect.objectContaining({ captureId: A_CAPTURE_ID })],
    });
  });

  /**
   * Extraction reads a *stored* Capture. A method taking text would let the
   * host extract from something never made durable, which is the ordering
   * Slice 2 built the whole ingestion sequence around.
   */
  it("fails for a Capture that was never stored", async () => {
    const response = await call(sidecarWith(anExtractor()), { captureId: "cap-nonexistent" });

    expect(response).toMatchObject({ error: { message: /No Capture cap-nonexistent/ } });
  });

  it("fails without a captureId rather than extracting something arbitrary", async () => {
    const response = await call(sidecarWith(anExtractor()), {});

    expect(response).toMatchObject({ error: { message: /requires a captureId/ } });
  });

  /**
   * A host that retries after a timeout must not re-bill the call. The stage
   * guarantees this; the method inherits it, and the test is here because the
   * retry happens at this level.
   */
  it("is idempotent, so a retrying host does not re-invoke the model", async () => {
    await storage.captures.put(aCapture({ rawText: A_NOTE }));
    const extractor = anExtractor();
    const extract = vi.spyOn(extractor, "extract");
    const methods = sidecarWith(extractor);

    await call(methods, { captureId: A_CAPTURE_ID });
    await call(methods, { captureId: A_CAPTURE_ID });

    expect(extract).toHaveBeenCalledTimes(1);
  });

  /**
   * The transport's own tests construct a sidecar with nothing to extract with,
   * and should not have to build an extractor to say something about the crash
   * window. The real sidecar always passes both.
   */
  it("is absent when the sidecar was built without an extractor", async () => {
    const methods = sidecarMethods({ ingestion: {} as never, transcriber: {} as never });

    expect(await call(methods, { captureId: A_CAPTURE_ID })).toMatchObject({
      error: { message: /no such method/ },
    });
  });
});
