import { CREATE_ENTITY } from "../../src/domain/commands/knowledge-commands.js";
import type { Command } from "../../src/domain/commands/command.js";
import type { Proposal } from "../../src/ports/proposal.js";

/**
 * Builders for what triage is asked about.
 *
 * The defaults describe the simplest thing triage sees: an unambiguous create
 * of a Person, under a named local model, with no resolution judgement behind
 * it. Every test overrides the one thing it is about, so a failure message
 * names the interesting value rather than burying it.
 */

/** The model a Proposal defaults to. Named, because thresholds key on the pair. */
export const A_MODEL = { provider: "local", modelVersion: "qwen2.5-7b-instruct" } as const;

/**
 * A Proposal for an unambiguous create.
 *
 * `confidences` defaults to a middling self-report and no resolution figure,
 * which is the shape a create carries: there was no candidate it was chosen
 * over, so `null` rather than 1 (`triage.md` §1).
 */
export function aProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    proposalId: "prop-1",
    captureId: "cap-1",
    command: aCommand(),
    confidences: { extraction: 0.8, resolution: null },
    resolution: { outcome: "unambiguous", wasAdjudicated: false, candidateCount: 0 },
    entityType: "Person",
    model: A_MODEL,
    proposedAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

/**
 * A `CreateEntity` Command against a new aggregate.
 *
 * `expectedVersion` is 0 because a create's target does not exist yet, which is
 * also what makes it the Command whose staleness check can never fail on a
 * first attempt.
 */
export function aCommand(overrides: Partial<Command> = {}): Command {
  return {
    type: CREATE_ENTITY,
    aggregate: { type: "Entity", id: "per-sarah", expectedVersion: 0 },
    payload: { entityType: "Person", name: "Sarah Chen" },
    provenance: {
      proposalId: "prop-1",
      captureId: "cap-1",
      provider: A_MODEL.provider,
      modelVersion: A_MODEL.modelVersion,
      confidence: 0.8,
      isHumanConfirmed: false,
    },
    ...overrides,
  };
}
