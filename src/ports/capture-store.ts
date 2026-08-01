import type { CaptureSource } from "../capture/capture-identity.js";

/**
 * Where Captures are stored, separate from the `EventStore` because Captures
 * are input rather than change (`add.md` §9).
 *
 * A Capture is what the user put into Otto; an event is a record that knowledge
 * changed. Storing them through one port would blur a distinction the whole
 * pipeline rests on — the log is truth about revisions, and `captures` is truth
 * about what arrived.
 *
 * Like `EventStore`, there is no update and no delete. `captures` is the other
 * table that is truth (`add.md` §10), insert-only in the application layer and
 * insert-only at the database level, because a test that the application
 * declines to do something is weaker than a database that will not permit it
 * (`qa.md` §4.1).
 */
export interface CaptureStore {
  /**
   * Stores a Capture, returning it as stored.
   *
   * A second insert of an existing `capture_id` is a no-op that returns the
   * stored Capture — not a throw, and not a silent overwrite. `EventStore`
   * already made this choice for events, and a storage port that throws where
   * its sibling no-ops means every caller has to learn which is which.
   * "Double-delivered input produces one Capture" (`qa.md` §4.3) is then a
   * property of the store rather than a rule every call site remembers.
   */
  put(capture: Capture): Promise<Capture>;

  /** The Capture with this id, or `null` if there is none. */
  get(captureId: string): Promise<Capture | null>;

  /**
   * Captures with no `CaptureIngested` event, oldest first.
   *
   * The startup sweep's query. The row is written before the event (`add.md`
   * §9 gives the two ports no shared transaction), so a crash between the two
   * leaves a Capture the log does not mention — invisible to the pipeline, and
   * recoverable, because the row holds everything the event's payload needs.
   *
   * Filtered to the ingestion event type rather than to any event at all: a
   * Capture with *some* event but no `CaptureIngested` is still unrecovered,
   * and an unfiltered anti-join would miss it once Slice 9 gives Captures a
   * second event type.
   */
  withoutIngestionEvent(): Promise<readonly Capture[]>;
}

/**
 * A Capture as it is stored: input, held immutably.
 *
 * Three text fields holding three different things, only one of them derived.
 * `rawText` is input, `correctedText` is a later human input, and the
 * normalised form is neither — it is computed on read from whichever of the two
 * is current, and deliberately not stored (`runtime.md` §5).
 */
export interface Capture {
  readonly captureId: string;
  readonly source: CaptureSource;
  /**
   * The text before any normalisation rule ran: the transcriber's output
   * verbatim for voice, the keystrokes as submitted for typed. Nothing trims
   * it, collapses it, or runs NFC over it — `contentHash` covers this column,
   * so changing it would change every id in the system.
   */
  readonly rawText: string;
  /**
   * What the user corrected the transcript to, `null` until Slice 9 writes it.
   * Declaring the field now is what makes that slice an append rather than a
   * second reshaping of the table.
   */
  readonly correctedText: string | null;
  /**
   * The model that produced a voice Capture's text, exactly as `whisper.cpp`
   * names it (e.g. `small.en`); `null` for a typed Capture.
   *
   * Not a display label, not a path, and not the binary's version: the model is
   * what a later re-transcription decision turns on. Outside the `capture_id`
   * hash — two recordings of the same audio under different models are the same
   * Capture, because the input did not change, only what read it.
   */
  readonly transcriptionModel: string | null;
  /** When the input arrived. For voice, when recording started (ADR-0018). */
  readonly sourceTimestamp: string;
  readonly contentHash: string;
  /** When the row was written, distinct from `sourceTimestamp`. */
  readonly ingestedAt: string;
}
