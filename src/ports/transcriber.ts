/**
 * Turning recorded audio into text (`add.md` §9).
 *
 * The one port where local is non-negotiable (ADR-0008, ADR-0016): voice is the
 * primary capture path, and a capture path that requires a network is not a
 * local-first system.
 *
 * It takes a path rather than bytes. The host records to a temporary file and
 * passes the path over stdio — audio bytes never cross the transport, because a
 * path is small and a WAV is not (`runtime.md` §2). That signature is also what
 * keeps the port mockable without a binary: everything the adapter needs is
 * behind it, so steps 1-7 of Slice 2 are testable on a clean checkout.
 */
export interface Transcriber {
  /**
   * The text spoken in the recording at `audioPath`.
   *
   * Returns the transcript verbatim — whitespace and all, before any
   * normalisation rule runs, because `content_hash` covers the raw form and
   * trimming here would change every id in the system.
   *
   * Throws rather than returning an empty string when transcription fails: a
   * failed transcription and a silent recording are different facts, and a
   * caller that cannot tell them apart would durably store silence as a
   * Capture.
   */
  transcribe(audioPath: string): Promise<Transcript>;
}

export interface Transcript {
  /** The transcriber's output, verbatim. */
  readonly text: string;
  /**
   * The model that produced it, exactly as `whisper.cpp` names it — `small.en`,
   * not a display label, a path, or the binary's version. It is what a later
   * re-transcription decision turns on, and it is recorded because it cannot be
   * reconstructed afterwards (ADR-0006).
   */
  readonly model: string;
}
