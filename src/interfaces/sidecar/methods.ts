import type { CaptureExtraction } from "../../application/pipeline/extract-capture.js";
import type { CaptureIngestion } from "../../application/pipeline/ingest-capture.js";
import type { CaptureStore } from "../../ports/capture-store.js";
import type { Transcriber } from "../../ports/transcriber.js";
import { captureMethods } from "./capture-methods.js";
import type { Methods } from "./dispatch.js";
import { extractionMethods } from "./extraction-methods.js";
import { reviewMethods } from "./review-methods.js";
import type { ProposalAdjudication } from "../../application/pipeline/adjudicate-proposal.js";
import type { DuplicateDetection } from "../../application/pipeline/detect-duplicates.js";
import type { BootstrapStatus } from "../../application/surface/read-bootstrap-status.js";
import type { ReviewQueue } from "../../application/surface/read-review-queue.js";

/**
 * Everything the sidecar answers.
 *
 * `ping` proves the round trip and `exit` makes the supervisor's restart paths
 * testable without signals. The two capture methods are the work: Slice 1's
 * `readAudio` placeholder is gone, replaced by `ingestVoice`, which transcribes
 * and persists before deleting (ADR-0018).
 *
 * The capture methods are omitted when there is nothing to ingest with, so the
 * transport and the supervisor stay testable without a database or a
 * transcriber behind them.
 */
export function sidecarMethods(capture?: CaptureDependencies): Methods {
  const base = { ping, exit: exitNow };
  if (capture === undefined) return base;
  return {
    ...base,
    ...captureMethods(capture.ingestion, capture.transcriber),
    ...extractionMethodsFor(capture),
    ...reviewMethodsFor(capture),
  };
}

/**
 * The review queue's methods, when there is a queue to serve them from.
 *
 * Optional for the same reason the others are: the transport's own tests have
 * nothing to review and should not have to construct a queue to say so. The
 * real sidecar passes all three.
 */
function reviewMethodsFor(capture: CaptureDependencies): Methods {
  const { review, adjudication, bootstrap, duplicates } = capture;
  if (review === undefined || adjudication === undefined || bootstrap === undefined) return {};
  return reviewMethods(review, adjudication, bootstrap, duplicates);
}

/**
 * The extraction method, when there is an extractor to serve it with.
 *
 * Optional for the same reason the capture methods are omitted without an
 * ingestion: a test about the crash window or the transport has nothing to
 * extract with and should not have to construct one to say so. The real sidecar
 * always passes both.
 */
function extractionMethodsFor(capture: CaptureDependencies): Methods {
  if (capture.extraction === undefined || capture.captures === undefined) return {};
  return extractionMethods(capture.extraction, capture.captures);
}

/** What the capture and extraction methods need. Absent in the transport's own tests. */
export interface CaptureDependencies {
  readonly ingestion: CaptureIngestion;
  readonly transcriber: Transcriber;
  readonly extraction?: CaptureExtraction;
  /** Extraction reads a *stored* Capture, so the method needs to fetch one. */
  readonly captures?: CaptureStore;
  /** The review queue's three lists (Slice 7). */
  readonly review?: ReviewQueue;
  /** Confirm and correct, which reach the executor without re-entering the pipeline. */
  readonly adjudication?: ProposalAdjudication;
  /** Why Otto is asking so much, so the dashboard can say (`triage.md` §4). */
  readonly bootstrap?: BootstrapStatus;
  /** The duplicate sweep, which queues suspected pairs and merges nothing (Slice 8). */
  readonly duplicates?: DuplicateDetection;
}

/**
 * The round-trip proof. Echoes back what it was sent so the host asserts a
 * response rather than merely that nothing threw.
 */
function ping(params: unknown): { pong: unknown } {
  return { pong: params ?? null };
}

/**
 * Exits on request, so the supervisor's restart and backoff paths are testable
 * without sending signals — a test that kills by signal is testing the
 * operating system, and on Windows it is testing something else entirely.
 */
function exitNow(params: unknown): never {
  const code = (params as { code?: unknown } | null)?.code;
  process.exit(typeof code === "number" ? code : 0);
}
