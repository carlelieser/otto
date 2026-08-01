import {
  CAPTURE_AGGREGATE,
  CAPTURE_INGESTED,
  CAPTURE_INGESTED_VERSION,
  type CaptureIngested,
  type CaptureIngestedPayload,
} from "../../src/domain/events/capture-ingested.js";
import { type Command, INGEST_CAPTURE } from "../../src/domain/commands/command.js";
import type { DomainEvent } from "../../src/domain/events/domain-event.js";
import type { Provenance } from "../../src/domain/values/provenance.js";

/** Provenance with every field populated; override only what a test is about. */
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

export function aCapturePayload(
  overrides: Partial<CaptureIngestedPayload> = {},
): CaptureIngestedPayload {
  return {
    captureId: "cap-1",
    source: "typed",
    text: "Coffee with Sarah about the Helios rollout.",
    sourceTimestamp: "2026-08-01T09:00:00.000Z",
    contentHash: "sha256:abc123",
    ...overrides,
  };
}

/** A well-formed IngestCapture Command; override only what a test is about. */
export function anIngestCapture(overrides: Partial<Command> = {}): Command {
  return {
    type: INGEST_CAPTURE,
    aggregate: { type: CAPTURE_AGGREGATE, id: "cap-1", expectedVersion: 0 },
    payload: aCapturePayload(),
    provenance: aProvenance(),
    ...overrides,
  };
}

const A_CAPTURE_INGESTED = {
  eventId: "evt-1",
  type: CAPTURE_INGESTED,
  version: CAPTURE_INGESTED_VERSION,
  aggregate: { type: CAPTURE_AGGREGATE, id: "cap-1", version: 0 },
  recordedAt: "2026-08-01T09:00:01.000Z",
} as const;

/** A well-formed CaptureIngested; override only what a test is about. */
export function aCaptureIngested(overrides: Partial<DomainEvent> = {}): CaptureIngested {
  const payload = aCapturePayload();
  const provenance = aProvenance();
  return { ...A_CAPTURE_INGESTED, payload, provenance, ...overrides } as CaptureIngested;
}
