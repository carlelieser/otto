import type { Provenance } from "../values/provenance.js";

/**
 * An expressed intent to change knowledge, in the imperative and naming its
 * target. May be refused (CONTEXT.md) — which is the whole difference between a
 * Command and the domain event it may produce.
 *
 * A Command carries the version of the aggregate it was computed against.
 * `expectedVersion` is what the executor checks at apply time: a Proposal that
 * sat in the review queue for three days while its target changed underneath it
 * fails that check rather than applying blindly (`add.md` §5.6).
 */
export interface Command<Payload = unknown> {
  readonly type: string;
  readonly aggregate: CommandTarget;
  readonly payload: Payload;
  readonly provenance: Provenance;
}

export interface CommandTarget {
  readonly type: string;
  readonly id: string;
  /**
   * The aggregate version this Command was computed against. A Command for a
   * new aggregate expects 0.
   */
  readonly expectedVersion: number;
}

/** The Command that ingests a Capture, producing `CaptureIngested`. */
export const INGEST_CAPTURE = "IngestCapture";

/**
 * The Command that corrects a voice transcript, producing
 * `CaptureTranscriptCorrected` (Slice 9, ADR-0014).
 *
 * The second Command a Capture accepts, and what gives the aggregate a version
 * 1 — until this slice, `expectedVersion` was inert on the Capture aggregate
 * because `CaptureIngested` was always version 0 of a new one.
 */
export const CORRECT_TRANSCRIPT = "CorrectTranscript";
