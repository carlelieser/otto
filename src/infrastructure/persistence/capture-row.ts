import type { CaptureSource } from "../../capture/capture-identity.js";
import type { Capture } from "../../ports/capture-store.js";

/** A `captures` row as SQLite returns it. */
export interface CaptureRow {
  readonly capture_id: string;
  readonly source: string;
  readonly raw_text: string;
  readonly corrected_text: string | null;
  readonly transcription_model: string | null;
  readonly source_timestamp: string;
  readonly content_hash: string;
  readonly ingested_at: string;
}

/** The bound parameters an insert needs. */
export function toInsertParameters(capture: Capture): Record<string, unknown> {
  return {
    capture_id: capture.captureId,
    source: capture.source,
    raw_text: capture.rawText,
    corrected_text: capture.correctedText,
    transcription_model: capture.transcriptionModel,
    source_timestamp: capture.sourceTimestamp,
    content_hash: capture.contentHash,
    ingested_at: capture.ingestedAt,
  };
}

/** A row rebuilt into the Capture it was stored from. */
export function toCapture(row: CaptureRow): Capture {
  return {
    captureId: row.capture_id,
    source: row.source as CaptureSource,
    rawText: row.raw_text,
    correctedText: row.corrected_text,
    transcriptionModel: row.transcription_model,
    sourceTimestamp: row.source_timestamp,
    contentHash: row.content_hash,
    ingestedAt: row.ingested_at,
  };
}
