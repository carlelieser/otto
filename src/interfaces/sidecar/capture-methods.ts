import { unlink } from "node:fs/promises";
import type { CaptureIngestion } from "../../application/pipeline/ingest-capture.js";
import type { Capture } from "../../ports/capture-store.js";
import type { Transcriber } from "../../ports/transcriber.js";
import type { Methods } from "./dispatch.js";

/** `YYYY-MM-DDTHH:MM:SS.sssZ` — millisecond precision, UTC, `Z` not `+00:00`. */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The two capture methods the host calls (ADR-0018).
 *
 * They differ in how they obtain text and what `source` they set; everything
 * after that is `CaptureIngestion`, so the write ordering has one
 * implementation rather than two chances to get it backwards.
 */
export function captureMethods(ingestion: CaptureIngestion, transcriber: Transcriber): Methods {
  return {
    ingestTyped: (params) => ingestTyped(params, ingestion),
    ingestVoice: (params) => ingestVoice(params, ingestion, transcriber),
  };
}

async function ingestTyped(params: unknown, ingestion: CaptureIngestion): Promise<Capture> {
  const { text, sourceTimestamp } = typedRequest(params);
  return ingestion.ingest({
    source: "typed",
    rawText: text,
    sourceTimestamp,
    transcriptionModel: null,
  });
}

/**
 * Transcribes the recording, persists the Capture, and *then* deletes the file.
 *
 * One call rather than two, which is what keeps the accepted crash window one
 * handler wide (`qa.md` §4.2, ADR-0018). A `transcribe` call followed by a
 * separate `ingest` call would put the durability boundary between two round
 * trips and make the host — the process with no database access — responsible
 * for closing a gap it structurally cannot.
 *
 * Deletion is last and only on success. Slice 1 established the ownership rule
 * with the host writing and the sidecar deleting; only the definition of
 * "successful" moves here, from a completed read to a durable Capture. A file
 * left behind by a failure is an orphan the supervisor sweeps on restart, which
 * is the recoverable outcome — deleting before the Capture is durable would
 * lose the audio with nothing to show for it.
 */
async function ingestVoice(
  params: unknown,
  ingestion: CaptureIngestion,
  transcriber: Transcriber,
): Promise<Capture> {
  const { path, sourceTimestamp } = voiceRequest(params);
  const { text, model } = await transcriber.transcribe(path);
  const capture = await ingestion.ingest({
    source: "voice",
    rawText: text,
    sourceTimestamp,
    transcriptionModel: model,
  });
  await unlink(path);
  return capture;
}

interface TypedRequest {
  readonly text: string;
  readonly sourceTimestamp: string;
}

function typedRequest(params: unknown): TypedRequest {
  const { text } = (params ?? {}) as { text?: unknown };
  if (typeof text !== "string") throw new Error("ingestTyped requires text");
  return { text, sourceTimestamp: requireSourceTimestamp(params, "ingestTyped") };
}

interface VoiceRequest {
  readonly path: string;
  readonly sourceTimestamp: string;
}

function voiceRequest(params: unknown): VoiceRequest {
  const { path } = (params ?? {}) as { path?: unknown };
  if (typeof path !== "string" || path === "") throw new Error("ingestVoice requires a path");
  return { path, sourceTimestamp: requireSourceTimestamp(params, "ingestVoice") };
}

/**
 * The recording-start time the host supplies, required rather than defaulted.
 *
 * Falling back to the sidecar's own clock would record transcription-completion
 * time under recording-start's name, and the resulting duplicate-Capture bug is
 * timing-dependent: the retried-upload test passes when transcription is fast
 * enough that both runs round to the same millisecond, and fails on a slower
 * machine. A required field turns that into an error at the call.
 *
 * The format is checked too, because the same instant formatted two ways hashes
 * two ways — and this value goes straight into `capture_id`.
 */
function requireSourceTimestamp(params: unknown, method: string): string {
  const { sourceTimestamp } = (params ?? {}) as { sourceTimestamp?: unknown };
  if (typeof sourceTimestamp !== "string" || !ISO_8601_UTC.test(sourceTimestamp)) {
    throw new Error(
      `${method} requires sourceTimestamp as YYYY-MM-DDTHH:MM:SS.sssZ, got ${String(sourceTimestamp)}`,
    );
  }
  return sourceTimestamp;
}
