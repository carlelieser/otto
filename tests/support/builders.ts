import {
  CAPTURE_AGGREGATE,
  CAPTURE_INGESTED,
  CAPTURE_INGESTED_VERSION,
  type CaptureIngested,
  type CaptureIngestedPayload,
} from "../../src/domain/events/capture-ingested.js";
import { type Command, INGEST_CAPTURE } from "../../src/domain/commands/command.js";
import type { DomainEvent } from "../../src/domain/events/domain-event.js";
import { humanConfirmedProvenance, type Provenance } from "../../src/domain/values/provenance.js";
import type { Capture } from "../../src/ports/capture-store.js";

/**
 * Provenance for an *inference*, with every field populated.
 *
 * This is not what a Capture carries. Ingestion has no model to name, so the
 * Capture builders below use `humanConfirmedProvenance` — see `aCapturePayload`.
 * This builder stays for the inference slices that will need it.
 */
export function aProvenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    proposalId: "prop-1",
    captureId: "cap-1",
    provider: "local",
    modelVersion: "qwen2.5-7b-instruct",
    confidence: 0.92,
    isHumanConfirmed: false,
    ...overrides,
  };
}

/** The raw text every Capture fixture is built from, and the hash it produces. */
const A_RAW_TEXT = "Coffee with Sarah about the Helios rollout.";
const A_CONTENT_HASH = "864aec1c5753d8b92a3910ef9cbcae906422e9cc6b676def8c70dbecda1eba97";
/**
 * The fixture Capture's id, derived from the raw text and timestamp above
 * rather than invented — `cap-1` is not a value the derivation can produce.
 */
export const A_CAPTURE_ID = "cap-0ee28d5f3077a14b63959caaf2f7415a";
const A_SOURCE_TIMESTAMP = "2026-08-01T09:00:00.000Z";

/**
 * Provenance for a Capture: `humanConfirmedProvenance`, because ingestion has
 * no model to name.
 *
 * Slice 0's fixture used an extraction's provenance here — `provider: "local"`,
 * a model version, and a confidence — which was well-formed and therefore never
 * failed. It was a placeholder from when `CaptureIngested` existed only to
 * prove the write path had two ends, and adopting it by imitation was the
 * likely failure mode, since it is the only worked example in the repository.
 *
 * A transcriber never proposes anything and has no Confidence to calibrate, so
 * naming `whisper.cpp` here would create a bootstrap bucket that can never fill
 * and a threshold row that is never read (`triage.md` §2, §4).
 */
export function aCaptureProvenance(captureId = A_CAPTURE_ID): Provenance {
  return humanConfirmedProvenance(captureId, null);
}

export function aCapturePayload(
  overrides: Partial<CaptureIngestedPayload> = {},
): CaptureIngestedPayload {
  return {
    captureId: A_CAPTURE_ID,
    source: "typed",
    text: A_RAW_TEXT,
    sourceTimestamp: A_SOURCE_TIMESTAMP,
    // 64 lowercase hex characters and no algorithm prefix — Slice 0's
    // `"sha256:abc123"` was not a value the derivation can produce, and
    // fixtures that cannot occur in production are how a wrong assumption
    // about format survives until something parses it.
    contentHash: A_CONTENT_HASH,
    ...overrides,
  };
}

/** A stored Capture; override only what a test is about. */
export function aCapture(overrides: Partial<Capture> = {}): Capture {
  return {
    captureId: A_CAPTURE_ID,
    source: "typed",
    rawText: A_RAW_TEXT,
    correctedText: null,
    transcriptionModel: null,
    sourceTimestamp: A_SOURCE_TIMESTAMP,
    contentHash: A_CONTENT_HASH,
    ingestedAt: "2026-08-01T09:00:01.000Z",
    ...overrides,
  };
}

/**
 * A well-formed IngestCapture Command; override only what a test is about.
 *
 * `expectedVersion` is 0 because `CaptureIngested` is always version 0 of a new
 * aggregate — the Capture is its own aggregate and `capture_id` its id.
 */
export function anIngestCapture(overrides: Partial<Command> = {}): Command {
  return {
    type: INGEST_CAPTURE,
    aggregate: { type: CAPTURE_AGGREGATE, id: A_CAPTURE_ID, expectedVersion: 0 },
    payload: aCapturePayload(),
    provenance: aCaptureProvenance(),
    ...overrides,
  };
}

const A_CAPTURE_INGESTED = {
  eventId: "evt-1",
  type: CAPTURE_INGESTED,
  version: CAPTURE_INGESTED_VERSION,
  aggregate: { type: CAPTURE_AGGREGATE, id: A_CAPTURE_ID, version: 0 },
  recordedAt: "2026-08-01T09:00:01.000Z",
} as const;

/** A well-formed CaptureIngested; override only what a test is about. */
export function aCaptureIngested(overrides: Partial<DomainEvent> = {}): CaptureIngested {
  const payload = aCapturePayload();
  const provenance = aCaptureProvenance();
  return { ...A_CAPTURE_INGESTED, payload, provenance, ...overrides } as CaptureIngested;
}
