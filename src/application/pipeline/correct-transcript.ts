import { CORRECT_TRANSCRIPT } from "../../domain/commands/command.js";
import type { Command } from "../../domain/commands/command.js";
import { CAPTURE_AGGREGATE } from "../../domain/events/capture-ingested.js";
import { humanConfirmedProvenance } from "../../domain/values/provenance.js";
import { isNonEmptyText } from "../../domain/values/text.js";
import type { Capture, CaptureStore } from "../../ports/capture-store.js";
import type { Clock, Executor } from "./execute-command.js";

/**
 * **Correcting a misheard transcript** (`runtime.md` §5, ADR-0014, PRD §5.5).
 *
 * Voice capture mishears names, and a mishearing becomes a wrong entity. This
 * is the one step that fixes it, and the whole of its difficulty is doing so
 * without weakening the immutability rule Captures rest on (ADR-0005).
 *
 * ## Nothing here mutates a Capture
 *
 * The correction is an event. The `corrected_text` column is written from that
 * event by `CaptureStore.recordCorrection`, which inserts rather than updates —
 * `captures` refuses UPDATE at the database level and continues to, so the
 * column is a materialisation of the log rather than a second truth that can
 * disagree with it. `raw_text` and `content_hash` are untouched, which is what
 * keeps every existing id in the system stable across a correction.
 *
 * ## It corrects what Otto heard, not what the user meant
 *
 * Only a voice Capture is correctable. A typed Capture was not misheard, and
 * editing one would be note editing, which PRD §6 excludes — so the refusal is
 * here, in the stage, rather than only in the surface that hides the button.
 * A rule enforced solely by an absent affordance is one the next caller can
 * bypass without noticing.
 */

/** What correcting a transcript is wired to. No extractor: see `correct`. */
export interface CorrectionDependencies {
  readonly captures: CaptureStore;
  /** The only writer in Otto (ADR-0003). */
  readonly executor: Executor;
  /**
   * The Capture aggregate's current version.
   *
   * A Capture is at version 1 after ingestion and moves with each correction,
   * so the Command has to be stamped with what the log actually holds — this is
   * the first thing in Otto to make that check live, since `CaptureIngested`
   * was always version 0 of a new aggregate.
   */
  readonly currentVersionOf: (aggregateId: string) => Promise<number>;
  /**
   * Rebuilds the Capture full-text index, which is derived from `captures`
   * rather than folded from the log.
   *
   * A correction changes the text that index holds, and no event carries a
   * Capture's text for the projection worker to fold — so without this, the
   * corrected transcript stays unsearchable until the next rebuild and search
   * keeps returning the misheard text as though nothing happened.
   *
   * Optional so the stage stays constructible without a projection store. A
   * test about the append path has no index to maintain and should not have to
   * build one to say so.
   */
  readonly reindexCaptures?: () => Promise<void>;
  readonly now: Clock;
}

/** A Capture that was typed was not misheard, so there is nothing to correct. */
export class TypedCaptureNotCorrectableError extends Error {
  constructor(readonly captureId: string) {
    super(
      `Cannot correct Capture ${captureId}: it was typed, not misheard. ` +
        `Correction fixes what Otto heard, not what the user meant (PRD §6).`,
    );
    this.name = "TypedCaptureNotCorrectableError";
  }
}

export class TranscriptCorrection {
  readonly #dependencies: CorrectionDependencies;

  constructor(dependencies: CorrectionDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Appends the correction and records it against the Capture.
   *
   * The event goes first and the column follows, which is the ordering
   * ingestion uses in reverse and for the same reason: the log is truth, so a
   * crash between the two leaves a column that can be rebuilt from the event
   * rather than an event describing a column that was never written.
   *
   * Re-extraction is deliberately **not** here. It is the caller's, because
   * this stage is the one that must reach no extractor for the immutability
   * argument to hold structurally — see `recorrect-capture.ts`.
   */
  async correct(captureId: string, correctedText: string): Promise<Capture> {
    const capture = await this.#correctable(captureId, correctedText);
    await this.#dependencies.executor.execute(await this.#commandFor(capture, correctedText));
    const corrected = await this.#dependencies.captures.recordCorrection(captureId, correctedText);
    await this.#dependencies.reindexCaptures?.();
    return corrected;
  }

  /** The Capture, if there is one and it is the kind that can be corrected. */
  async #correctable(captureId: string, correctedText: string): Promise<Capture> {
    if (!isNonEmptyText(correctedText)) {
      throw new Error(`Cannot correct Capture ${captureId}: the corrected text is empty`);
    }
    const capture = await this.#dependencies.captures.get(captureId);
    if (capture === null) throw new Error(`Cannot correct Capture ${captureId}: no such Capture`);
    if (capture.source !== "voice") throw new TypedCaptureNotCorrectableError(captureId);
    return capture;
  }

  /** The Command, stamped with the version the Capture aggregate now holds. */
  async #commandFor(capture: Capture, correctedText: string): Promise<Command> {
    const { captureId } = capture;
    const expectedVersion = await this.#dependencies.currentVersionOf(captureId);
    return {
      type: CORRECT_TRANSCRIPT,
      aggregate: { type: CAPTURE_AGGREGATE, id: captureId, expectedVersion },
      payload: { captureId, correctedText, correctedAt: this.#dependencies.now() },
      // The user said what was said. No model proposed it, so there is no
      // Confidence to record and no provider to name (ADR-0002).
      provenance: humanConfirmedProvenance(captureId, null),
    };
  }
}
