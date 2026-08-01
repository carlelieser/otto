import type { Capture, CaptureStore } from "../../ports/capture-store.js";
import type { CaptureIngestion } from "./ingest-capture.js";

/**
 * The startup sweep: `CaptureIngested` re-emitted for rows that have none.
 *
 * Ingestion writes the `captures` row before the event, so a crash between the
 * two writes leaves a Capture the log does not mention — invisible to the
 * pipeline, and recoverable, because the row holds everything the payload
 * needs.
 *
 * It needs no bookkeeping of its own, and that is the property worth
 * protecting. `deriveEventId` hashes the Capture id and not the payload
 * (`identifyingParts` lists provenance, type, and aggregate — nothing derived
 * from the text), so re-emitting an event that did land is the no-op
 * `EventStore.append` already guarantees. That is also what makes the sweep
 * safe to run against a row whose normalised text would differ under a changed
 * normaliser: re-emission cannot fork the log.
 */
export class CaptureRecovery {
  readonly #captures: CaptureStore;
  readonly #ingestion: CaptureIngestion;

  constructor(captures: CaptureStore, ingestion: CaptureIngestion) {
    this.#captures = captures;
    this.#ingestion = ingestion;
  }

  /**
   * Re-emits the ingestion event for every Capture missing one, returning them.
   *
   * Idempotent by construction rather than by bookkeeping: a second pass
   * appends nothing, because the first pass gave every row an event and the
   * anti-join no longer returns it.
   */
  async recoverUningestedCaptures(): Promise<readonly Capture[]> {
    const unrecovered = await this.#captures.withoutIngestionEvent();
    for (const capture of unrecovered) {
      await this.#ingestion.appendIngestedEvent(capture);
    }
    return unrecovered;
  }
}
