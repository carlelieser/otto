import type { DomainEvent } from "./domain-event.js";

/**
 * **The user corrected what Otto heard** (`runtime.md` §5, ADR-0014).
 *
 * Transcription is imperfect and Captures are immutable (ADR-0005), and this
 * event is how those two hold at once: the correction is appended like any
 * other change, and `raw_text` is never touched. Both texts stay readable,
 * which is what makes "why does Otto think this?" answerable after a correction
 * as well as before one.
 *
 * ## It corrects what Otto *heard*, not what the user *meant*
 *
 * PRD §6 excludes note editing, and this is not an exception to it. A voice
 * Capture's text is a transcriber's guess at what was said; correcting it is
 * saying the guess was wrong. Rewriting a note to say something different is a
 * document editor, which Otto is not — so **only a voice Capture carries this
 * event**, and the check that enforces it is in `correct-transcript.ts` rather
 * than here, because a payload cannot see the Capture it targets.
 *
 * ## The corrected text is on the event, not only in a column
 *
 * `captures.corrected_text` exists and this slice is the first thing to write
 * it — but the event is what is true, and the column is derived from it. That
 * ordering is what keeps a correction from needing an UPDATE against a table
 * whose triggers refuse one.
 */
export const CAPTURE_TRANSCRIPT_CORRECTED = "CaptureTranscriptCorrected";

export const CAPTURE_TRANSCRIPT_CORRECTED_VERSION = 1;

export interface CaptureTranscriptCorrectedPayload {
  readonly captureId: string;
  /**
   * What the user corrected the transcript to, normalised on read like every
   * other text in Otto.
   *
   * The raw transcript is deliberately **not** repeated here. It is already on
   * `CaptureIngested` and in `captures.raw_text`, and a third copy would be a
   * third thing that can disagree with the other two.
   */
  readonly correctedText: string;
  /** When the user corrected it, ISO 8601. */
  readonly correctedAt: string;
}

export type CaptureTranscriptCorrected = DomainEvent<CaptureTranscriptCorrectedPayload>;

export function isCaptureTranscriptCorrected(
  event: DomainEvent,
): event is CaptureTranscriptCorrected {
  return event.type === CAPTURE_TRANSCRIPT_CORRECTED;
}
