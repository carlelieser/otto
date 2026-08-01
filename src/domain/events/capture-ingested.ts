import type { DomainEvent } from "./domain-event.js";

/**
 * A Capture became durable. The one event type Slice 0 carries, chosen because
 * Slice 1 needs it anyway.
 *
 * The payload holds what ingestion produced and nothing semantic: ingestion
 * turns arriving input into a Capture and stops (`add.md` §5.1). Whatever the
 * text *means* is extraction's business, one stage later.
 */
export const CAPTURE_INGESTED = "CaptureIngested";

/** The aggregate type a Capture's events target. */
export const CAPTURE_AGGREGATE = "Capture";

export const CAPTURE_INGESTED_VERSION = 1;

export interface CaptureIngestedPayload {
  readonly captureId: string;
  /** Where the input arrived from, e.g. voice or typed. */
  readonly source: string;
  /** The normalised text; the raw transcript for a voice Capture. */
  readonly text: string;
  /** When the input arrived, ISO 8601, distinct from when it was recorded. */
  readonly sourceTimestamp: string;
  /**
   * sha256_hex of the raw text, before normalisation — 64 lowercase hex
   * characters, no algorithm prefix (`runtime.md` §3).
   *
   * An *input* to `capture_id` rather than the idempotency key itself: the key
   * is `captureId`, which hashes this together with `source` and
   * `sourceTimestamp`.
   */
  readonly contentHash: string;
}

export type CaptureIngested = DomainEvent<CaptureIngestedPayload>;

export function isCaptureIngested(event: DomainEvent): event is CaptureIngested {
  return event.type === CAPTURE_INGESTED;
}
