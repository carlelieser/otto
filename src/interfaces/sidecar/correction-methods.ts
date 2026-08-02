import {
  requireCorrectedText,
  type TranscriptCorrection,
} from "../../application/pipeline/correct-transcript.js";
import type { CaptureReextraction } from "../../application/pipeline/reextract-capture.js";
import type { Capture } from "../../ports/capture-store.js";
import type { ExtractedProposal } from "../../ports/proposal-store.js";
import type { Methods } from "./dispatch.js";

/**
 * **Correcting a misheard transcript, in one call** (`runtime.md` §5, PRD §5.5).
 *
 * One method rather than two, and that is the affordance: the slice's promise
 * is that a misheard name is fixable in one step, so a `correct` call followed
 * by a separate `reextract` call would put the re-run in the caller's hands and
 * make "the entity Otto derived updates" something a surface has to remember.
 *
 * **There is deliberately no method that corrects a typed Capture**, and none
 * that edits note text. The stage refuses a typed Capture (PRD §6), and the
 * surface is expected not to offer the affordance at all — `qa.md` §7.6 asks
 * for the *absence*, which is why this module is omitted entirely when nothing
 * correctable is wired rather than registered and left to fail.
 */
export function correctionMethods(
  correction: TranscriptCorrection,
  reextraction: CaptureReextraction,
): Methods {
  return {
    correctTranscript: (params) => correctTranscript(params, correction, reextraction),
  };
}

/** What a correction produced: the Capture, the re-run, and what is new in it. */
interface CorrectionResult {
  readonly capture: Capture;
  /** Everything the corrected text extracted, whether or not it is new. */
  readonly proposals: readonly ExtractedProposal[];
  /**
   * The Proposals that were not already recorded.
   *
   * Empty when the re-run confirmed what Otto already believed, which is the
   * case `runtime.md` §3 closes silently: most re-extraction confirms, and only
   * the differences are worth the user's attention.
   */
  readonly emerged: readonly ExtractedProposal[];
}

/**
 * Corrects the transcript and re-runs extraction for that Capture.
 *
 * **The one case where re-extraction is automatic** (`runtime.md` §3): the user
 * has explicitly said the input was wrong, so Otto re-reads the note without
 * being asked again. Everywhere else re-extraction is manual and scoped.
 *
 * Extraction is as far as it goes, because that is as far as Otto goes — the
 * stages past it have no driver yet (ADR-0026). A caller receives what the
 * corrected text extracted and what is new in it, and nothing here pretends a
 * resolution or a triage decision followed.
 *
 * The order is load-bearing. The correction is appended and materialised first,
 * so the Capture the re-run reads is the corrected one — re-extracting before
 * the correction is durable would read the misheard text and record Proposals
 * the user has already said are wrong.
 */
async function correctTranscript(
  params: unknown,
  correction: TranscriptCorrection,
  reextraction: CaptureReextraction,
): Promise<CorrectionResult> {
  const { captureId, correctedText } = correctionRequest(params);
  const capture = await correction.correct(captureId, correctedText);
  // One run, both answers. Asking for the re-run and then for what is new in
  // it would call the model twice for one correction.
  return { capture, ...(await reextraction.reextract(capture)) };
}

interface CorrectionRequest {
  readonly captureId: string;
  readonly correctedText: string;
}

/**
 * The two parameters, with only the transport's half decided here.
 *
 * A missing `captureId` is a malformed request and this is the place to say so.
 * Whether the text is *substantive* is a question about corrections, so it is
 * `requireCorrectedText`'s — a second copy here would have accepted `"   "` at
 * the transport and had the stage refuse it one call later.
 */
function correctionRequest(params: unknown): CorrectionRequest {
  const { captureId, correctedText } = (params ?? {}) as Partial<CorrectionRequest>;
  if (typeof captureId !== "string" || captureId === "") {
    throw new Error("correctTranscript requires a captureId");
  }
  return { captureId, correctedText: requireCorrectedText(captureId, correctedText) };
}
