import { createHash } from "node:crypto";

/**
 * The two id derivations of `runtime.md` §3, written to the byte.
 *
 * Dedup is only as stable as its least-specified term. Naming a hash function
 * is not enough to make two implementers agree: a separator, a field order, and
 * a digest width are all places two implementations diverge silently and
 * produce duplicate Captures. So every term is fixed here rather than described.
 *
 * These are pure functions with no I/O, which is what makes them the easiest
 * thing in the slice to pin — and they are pinned by golden values, because a
 * property-based test confirms a derivation is *consistent* and a
 * wrong-but-consistent implementation satisfies that too. Only a literal
 * catches a changed separator, a reordered field, or a different truncation.
 */

/**
 * How many hex characters of the digest an id carries, matching
 * `deriveEventId`'s `ID_LENGTH`. Two id schemes in one system invites a third.
 */
const ID_LENGTH = 32;

/** The separator `deriveEventId` joins with, restated rather than pointed at. */
const SEPARATOR = " ";

/** Where the input arrived from. A closed set of two, and part of a hash input. */
export const CAPTURE_SOURCES = ["typed", "voice"] as const;

export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

/** SHA-256 over the UTF-8 encoding of `parts`, joined, as lowercase hex. */
function sha256Hex(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join(SEPARATOR), "utf8").digest("hex");
}

/**
 * The content hash: the full 64-character digest of the raw text.
 *
 * Over `raw_text`, *before* normalisation. Normalisation is a pure function of
 * the raw text, so hashing the raw form is strictly more discriminating, and it
 * keeps the key stable if a normalisation rule is ever changed — hashing
 * normalised text would silently re-key every existing Capture the day
 * whitespace handling is touched.
 *
 * The cost is worth naming: because NFC runs in normalisation rather than
 * before the hash, the same visible text in two Unicode forms is two Captures.
 * That is accepted. It is vanishingly rare from one user on one machine with
 * one keyboard and one transcriber, and the alternative puts the normaliser
 * inside the id derivation, where changing a rule re-keys the corpus. A stable
 * key with a rare false negative beats an unstable one.
 *
 * Not truncated — nothing requires it to be and a full digest costs nothing in
 * a `TEXT` column — and carrying no algorithm prefix, like every hash in Otto.
 */
export function deriveContentHash(rawText: string): string {
  return sha256Hex([rawText]);
}

/** What a Capture's id is derived from. `sourceTimestamp` is when the input arrived. */
export interface CaptureIdentity {
  readonly source: CaptureSource;
  /**
   * ISO 8601, UTC, exactly `YYYY-MM-DDTHH:MM:SS.sssZ`. For a voice Capture this
   * is when recording *started* — recording end and transcription-completion
   * are properties of the run rather than the input, so either would give a
   * re-upload of identical audio a different id (ADR-0018).
   */
  readonly sourceTimestamp: string;
  readonly contentHash: string;
}

/**
 * A Capture's id, and the idempotency key double-delivered input collapses on.
 *
 * Truncated to 32 characters after the `cap-` prefix to match `deriveEventId`.
 * The field order and the single-space separator are exactly as listed: two
 * implementers reading only "matches `deriveEventId`" produce two id schemes
 * and no dedup.
 */
export function deriveCaptureId(identity: CaptureIdentity): string {
  const { source, sourceTimestamp, contentHash } = identity;
  return `cap-${sha256Hex([source, sourceTimestamp, contentHash]).slice(0, ID_LENGTH)}`;
}

/** The pipeline stage that produced a Proposal. Extended only by a slice that adds one. */
export const PROPOSAL_STAGES = ["extraction", "resolution"] as const;

export type ProposalStage = (typeof PROPOSAL_STAGES)[number];

/** What a Proposal's id is derived from (`runtime.md` §3). */
export interface ProposalIdentity {
  /** The full 36-character `cap-`-prefixed id, neither re-hashed nor stripped first. */
  readonly captureId: string;
  readonly stage: ProposalStage;
  readonly provider: string;
  readonly modelVersion: string;
  /** The Proposal's zero-based index within its stage for that Capture, as emitted. */
  readonly ordinal: number;
}

/**
 * A Proposal's id. Nothing produces one until Slice 3; it lives here because
 * the two derivations have to be read together, and their difference is the
 * whole of `runtime.md` §3.
 *
 * Same digest, separator, truncation, and prefix convention as `capture_id` —
 * only the field list differs. `provider` and `modelVersion` are in the hash on
 * purpose, and that is the half that pulls against the other: a retry under the
 * same model produces identical ids and is a no-op, while a re-run under a
 * *better* model produces new ids and therefore new Proposals. A better model
 * should be able to say something new about an old Capture (ADR-0011); an id
 * derived from the Capture alone would make re-extraction silently impossible.
 *
 * `ordinal` is what keeps two Mentions from one Capture, one model, and one
 * stage from colliding. Rendered with `String()`, so `0` and not `"0.0"`.
 */
export function deriveProposalId(identity: ProposalIdentity): string {
  const { captureId, stage, provider, modelVersion, ordinal } = identity;
  const parts = [captureId, stage, provider, modelVersion, String(ordinal)];
  return `prop-${sha256Hex(parts).slice(0, ID_LENGTH)}`;
}

/**
 * What a Correction's id is derived from: the Proposal it corrects, and the
 * answer the user gave.
 *
 * Deliberately **not** the Capture, the model, or the clock. A Correction is
 * the user's answer to one Proposal, and the model that produced the Proposal
 * is already fixed by the `proposalId` term — hashing it again would only make
 * the input longer.
 */
export interface CorrectionIdentity {
  readonly proposalId: string;
  /** The chosen Command's type, e.g. `SetField`. */
  readonly chosenType: string;
  /** The id of the aggregate the chosen Command targets. */
  readonly chosenTargetId: string;
  /** The chosen Command's payload, serialised canonically by the caller. */
  readonly chosenPayload: string;
}

/**
 * A Correction's id, derived from the Proposal and **the answer the user gave**.
 *
 * The answer is in the hash, and that is the decision. Deriving from the
 * `proposalId` alone would make the id an "this was corrected" key, so a user
 * who corrected a field to `Acme`, thought again, and corrected it to `Globex`
 * would have the second answer collapse into the first as a no-op — losing the
 * one they actually meant. Including the chosen Command makes a *repeat* of the
 * same correction idempotent, which is the double-click case that actually
 * needs collapsing, while a genuinely different answer is a different row.
 *
 * Same digest, separator, truncation, and prefix convention as the two
 * derivations above. The `corr-` prefix continues the pattern rather than
 * starting a second one.
 */
export function deriveCorrectionId(identity: CorrectionIdentity): string {
  const { proposalId, chosenType, chosenTargetId, chosenPayload } = identity;
  const parts = [proposalId, chosenType, chosenTargetId, chosenPayload];
  return `corr-${sha256Hex(parts).slice(0, ID_LENGTH)}`;
}

/** The two identities a suspected duplicate names, in the direction proposed. */
export interface DuplicateIdentity {
  readonly survivorId: string;
  readonly mergedId: string;
}

/**
 * A suspected duplicate's Proposal id, derived from **the pair alone**.
 *
 * The three derivations above all take a Capture, and this one cannot: a
 * suspected duplicate comes from comparing the entity table against itself, and
 * no note said anything about it. Nothing else about the pair is in the hash
 * either — not the similarity, not the clock — because the sweep runs repeatedly
 * over a table that mostly does not change, and an id carrying either would make
 * every run a fresh queue entry for a question the user has already been asked.
 *
 * Deriving from the pair makes a repeated detection idempotent, which is the
 * same property `deriveProposalId` gets from hashing the model: running again
 * changes nothing unless what is being proposed changed.
 *
 * `dup-` continues the prefix pattern rather than starting a second one, and the
 * digest, separator, and truncation are the ones every id in Otto uses.
 */
export function deriveDuplicateId(identity: DuplicateIdentity): string {
  const { survivorId, mergedId } = identity;
  return `dup-${sha256Hex([survivorId, mergedId]).slice(0, ID_LENGTH)}`;
}
