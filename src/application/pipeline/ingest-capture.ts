import {
  type CaptureSource,
  deriveCaptureId,
  deriveContentHash,
} from "../../capture/capture-identity.js";
import { normalise } from "../../capture/normalise.js";
import { INGEST_CAPTURE } from "../../domain/commands/command.js";
import { CAPTURE_AGGREGATE } from "../../domain/events/capture-ingested.js";
import type { Command } from "../../domain/commands/command.js";
import { humanConfirmedProvenance } from "../../domain/values/provenance.js";
import type { Capture, CaptureStore } from "../../ports/capture-store.js";
import type { EventStore } from "../../ports/event-store.js";
import type { Clock, Executor } from "./execute-command.js";

/** What `currentVersion` returns for an aggregate with no events yet. */
const NO_EVENTS_YET = 0;

/** The two truth tables ingestion writes to, in the order it writes them. */
export interface IngestionStores {
  readonly captures: CaptureStore;
  readonly events: EventStore;
}

/** What arriving input carries, whichever path it came in on. */
export interface ArrivingCapture {
  readonly source: CaptureSource;
  /** Before normalisation: the transcriber's output verbatim, or the keystrokes as submitted. */
  readonly rawText: string;
  /** ISO 8601 `YYYY-MM-DDTHH:MM:SS.sssZ`. For voice, when recording started (ADR-0018). */
  readonly sourceTimestamp: string;
  /** The model that produced a voice Capture's text; `null` for a typed one. */
  readonly transcriptionModel: string | null;
}

/**
 * Turning arriving input into a durable Capture, and nothing semantic.
 *
 * `add.md` §5.1 draws the line: ingestion transcribes, cleans up, timestamps,
 * and deduplicates. It does not notice dates, which is the specific example the
 * ADD uses for what belongs to extraction one stage later. The temptation is
 * constant and giving in turns the normaliser into a second, undisciplined
 * extractor.
 *
 * Both capture paths run through here (ADR-0018). They differ only in how they
 * obtain text and what `source` they set; everything after that is this one
 * function, because build order step 4's sequence is easy to get backwards and
 * two call sites each remembering it would be two chances to.
 */
export class CaptureIngestion {
  readonly #captures: CaptureStore;
  readonly #events: EventStore;
  readonly #executor: Executor;
  readonly #now: Clock;

  constructor(stores: IngestionStores, executor: Executor, now: Clock) {
    this.#captures = stores.captures;
    this.#events = stores.events;
    this.#executor = executor;
    this.#now = now;
  }

  /**
   * Ingests arriving input, returning the durable Capture.
   *
   * The order is load-bearing: derive the id, write the row, *then* append the
   * event. The id comes first because `deriveEventId` hashes
   * `provenance.captureId`, so the Command cannot be built until it exists.
   *
   * The row goes before the event because the two ports share no transaction
   * (`add.md` §9) and one of the two orders has to survive a crash between
   * them. A `captures` row with no event is invisible to the pipeline but
   * recoverable — the row holds everything the payload needs, and re-running
   * ingestion produces the identical `capture_id` and therefore the identical
   * `eventId`. The reverse fails worse: an event pointing at a row that does
   * not exist is a dangling reference in the table that is truth, and the log
   * cannot be repaired without violating its own append-only rule.
   */
  async ingest(arriving: ArrivingCapture): Promise<Capture> {
    const capture = await this.#captures.put(this.#asCapture(arriving));
    await this.appendIngestedEvent(capture);
    return capture;
  }

  /**
   * Whether this Capture's ingestion event is already on the log.
   *
   * Checked before appending, and the reason is subtler than it looks. The
   * store collapses a re-delivery into one row, and `EventStore.append`
   * collapses a re-emitted event into one entry — but the executor's staleness
   * check sits in front of the append and fires first: a second ingestion
   * arrives with `expectedVersion: 0` against an aggregate already at version
   * 1, and `StaleCommandError` is thrown before `append` can no-op it.
   *
   * A retried voice upload is exactly that case (`qa.md` §4.3), and it has to
   * be a no-op rather than a throw. Asking first is what makes the append
   * idempotent from the caller's side; it is not a substitute for the store's
   * own idempotency, which still covers a genuine concurrent double-append.
   */
  async #hasIngestionEvent(capture: Capture): Promise<boolean> {
    const version = await this.#events.currentVersion(capture.captureId);
    return version > NO_EVENTS_YET;
  }

  /** The row, with its id derived from the raw text rather than the normalised form. */
  #asCapture(arriving: ArrivingCapture): Capture {
    const contentHash = deriveContentHash(arriving.rawText);
    const { source, sourceTimestamp } = arriving;
    return {
      captureId: deriveCaptureId({ source, sourceTimestamp, contentHash }),
      source,
      rawText: arriving.rawText,
      correctedText: null,
      transcriptionModel: arriving.transcriptionModel,
      sourceTimestamp,
      contentHash,
      ingestedAt: this.#now(),
    };
  }

  /**
   * Appends `CaptureIngested` for a stored Capture.
   *
   * Also the startup sweep's recovery step, which is why it takes a stored
   * Capture rather than arriving input: re-emitting for a row that already has
   * its event is the no-op `EventStore.append` guarantees, because
   * `deriveEventId` hashes the Capture id and not the payload.
   */
  async appendIngestedEvent(capture: Capture): Promise<void> {
    if (await this.#hasIngestionEvent(capture)) return;
    await this.#executor.execute(toIngestCommand(capture));
  }
}

/**
 * The Command a stored Capture implies.
 *
 * `expectedVersion` is 0 for every ingestion: the Capture is its own aggregate
 * and `CaptureIngested` is always version 0 of a new one, so the staleness
 * check can only fire if the same Capture is ingested twice concurrently —
 * which the single-threaded pipeline (`add.md` §4) already prevents. The
 * machinery is inert here by construction rather than by luck, and Slice 9's
 * `CaptureTranscriptCorrected` is what gives the aggregate a version 1 and
 * makes the check live.
 */
function toIngestCommand(capture: Capture): Command {
  return {
    type: INGEST_CAPTURE,
    aggregate: { type: CAPTURE_AGGREGATE, id: capture.captureId, expectedVersion: 0 },
    payload: {
      captureId: capture.captureId,
      source: capture.source,
      // The normalised form, derived on read. Not stored, because a stored copy
      // would be a second truth that can disagree with the first.
      text: normalise(capture.rawText),
      sourceTimestamp: capture.sourceTimestamp,
      contentHash: capture.contentHash,
    },
    // Ingestion has no model to name. `isHumanConfirmed` does not assert the
    // transcript is accurate — it asserts nothing unattended decided anything.
    provenance: humanConfirmedProvenance(capture.captureId, null),
  };
}
