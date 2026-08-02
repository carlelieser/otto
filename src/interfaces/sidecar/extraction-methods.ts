import type { CaptureExtraction } from "../../application/pipeline/extract-capture.js";
import type { CaptureStore } from "../../ports/capture-store.js";
import type { ExtractedProposal } from "../../ports/proposal-store.js";
import type { Methods } from "./dispatch.js";

/**
 * The extraction stage, reachable over the transport.
 *
 * One method, and it takes a Capture id rather than text: extraction reads a
 * *stored* Capture, so a method taking text would let the host extract from
 * something that was never made durable — which is the ordering `add.md` §5.1
 * fixes and Slice 2 built the whole ingestion sequence around.
 *
 * It is idempotent for the same reason the stage is: asking twice returns the
 * recorded Proposals without calling the model again, so a host that retries
 * after a timeout does not re-bill the call.
 */
export function extractionMethods(extraction: CaptureExtraction, captures: CaptureStore): Methods {
  return {
    extractCapture: (params) => extractCapture(params, extraction, captures),
  };
}

async function extractCapture(
  params: unknown,
  extraction: CaptureExtraction,
  captures: CaptureStore,
): Promise<readonly ExtractedProposal[]> {
  const captureId = requireCaptureId(params);
  const capture = await captures.get(captureId);
  if (capture === null) throw new Error(`No Capture ${captureId} to extract`);
  return extraction.extract(capture);
}

function requireCaptureId(params: unknown): string {
  const { captureId } = (params ?? {}) as { captureId?: unknown };
  if (typeof captureId !== "string" || captureId === "") {
    throw new Error("extractCapture requires a captureId");
  }
  return captureId;
}
