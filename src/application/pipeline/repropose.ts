import type { ClaimedValue } from "../../domain/knowledge/claimed-value.js";
import type { Entity } from "../../domain/knowledge/entity.js";
import type { Disposition } from "../../domain/policies/disposition.js";
import { diffEntity } from "../../inference/differ/diff-entity.js";
import type { Proposal } from "../../ports/proposal.js";

/**
 * **A stale Proposal is re-proposed against current state, never applied
 * blindly** (`triage.md` §8, `add.md` §5.6).
 *
 * A Proposal is stamped with the version of the aggregate it was computed
 * against. One that sat in the review queue for three days while its target
 * changed fails that check at apply time and arrives here. This is the only
 * place in Otto that needs concurrency control, and it needs it because of
 * **user think-time rather than parallelism** (`qa.md` §2).
 *
 * ## It re-enters from the differ, not from extraction
 *
 * The extracted values are still valid — the text did not change, only the
 * comparison against current state. So this is a cheap deterministic re-diff
 * with **no LLM call**, and no extractor is reachable from here: this module
 * imports the differ and nothing model-facing, which is what makes "the
 * extractor is not invoked" a property of the code rather than a claim a test
 * has to catch after the fact.
 *
 * ## Three outcomes, and two of them are not "show it again"
 *
 * A re-proposal producing **no change is closed**: the user's own edit already
 * made the change the proposal wanted, so re-queueing it would ask them to
 * confirm what they just did. A re-proposal producing a **different change goes
 * to review regardless of Confidence**, because the thing the user was looking
 * at changed underneath them — and that rule is expressed here by never
 * consulting triage at all, rather than by comparing a number against a
 * threshold that could later be tuned into being wrong.
 */

/** What a re-proposal needs: current state, and the values the note claimed. */
export interface ReproposalContext {
  /** The target as it now stands, or `undefined` if it no longer exists. */
  readonly current: Entity | undefined;
  /** The claimed values from the original extraction. Still valid; the text stands. */
  readonly claimed: readonly ClaimedValue[];
}

/** What re-proposing produced. */
export type ReproposalOutcome =
  | {
      readonly kind: "changed";
      readonly proposal: Proposal;
      /**
       * Always `needs_review`. Present rather than implied so the caller stores
       * a disposition from the same vocabulary as every other path.
       */
      readonly disposition: Disposition;
    }
  /** Satisfied or unresolvable. Recorded as such rather than shown again. */
  | { readonly kind: "closed"; readonly reason: ClosureReason };

export const CLOSURE_REASONS = ["no_change", "target_gone"] as const;

export type ClosureReason = (typeof CLOSURE_REASONS)[number];

/** The Proposal `proposal` becomes against current state, or its closure. */
export async function reproposeAgainst(
  proposal: Proposal,
  context: ReproposalContext,
): Promise<ReproposalOutcome> {
  const { current, claimed } = context;
  if (current === undefined) return { kind: "closed", reason: "target_gone" };

  const { changes } = diffEntity(current, claimed);
  const change = changes[0];
  if (change === undefined) return { kind: "closed", reason: "no_change" };

  return {
    kind: "changed",
    proposal: restamped(proposal, current, change),
    disposition: "needs_review",
  };
}

/**
 * The Proposal as it now stands: the new change, against the version it was
 * actually computed on.
 *
 * The id is carried through unchanged. This is the same claim about the same
 * Capture under the same model — `runtime.md` §3's derivation would produce the
 * same id anyway, and a new one would orphan whatever the user was looking at.
 */
function restamped(
  proposal: Proposal,
  current: Entity,
  change: { readonly type: string; readonly payload: unknown },
): Proposal {
  return {
    ...proposal,
    command: {
      ...proposal.command,
      type: change.type,
      payload: change.payload,
      aggregate: { ...proposal.command.aggregate, expectedVersion: current.version },
    },
  };
}
