import type { CaptureIngestion } from "../../application/pipeline/ingest-capture.js";
import type { Transcriber } from "../../ports/transcriber.js";
import { captureMethods } from "./capture-methods.js";
import type { Methods } from "./dispatch.js";

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
  return { ...base, ...captureMethods(capture.ingestion, capture.transcriber) };
}

/** What the capture methods need. Absent in the transport's own tests. */
export interface CaptureDependencies {
  readonly ingestion: CaptureIngestion;
  readonly transcriber: Transcriber;
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
