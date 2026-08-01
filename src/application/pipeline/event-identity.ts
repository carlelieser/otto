import { createHash } from "node:crypto";
import type { Command } from "../../domain/commands/command.js";

/** How many hex characters of the digest an event id carries. */
const ID_LENGTH = 32;

/**
 * A deterministic event id, so that replaying a Command appends one event
 * rather than two.
 *
 * `runtime.md` §3 derives downstream ids from the Capture id, the stage, the
 * provider, the model version, and an ordinal. The provider and model version
 * are in there deliberately: a retry under the same model is a no-op, while a
 * re-run under a *better* model produces new ids and therefore new Proposals,
 * which is the correct behaviour. An id derived from the Capture alone would
 * silently make re-extraction impossible (ADR-0011).
 */
export function deriveEventId(command: Command): string {
  const identity = identifyingParts(command).join(" ");
  return `evt-${createHash("sha256").update(identity).digest("hex").slice(0, ID_LENGTH)}`;
}

/** Everything that makes this Command a distinct write, in a fixed order. */
function identifyingParts({ provenance, aggregate, type }: Command): readonly string[] {
  return [
    provenance.captureId,
    provenance.proposalId ?? "",
    type,
    aggregate.id,
    String(aggregate.expectedVersion),
    provenance.provider,
    provenance.modelVersion,
  ];
}
