import type { Command } from "../domain/commands/command.js";
import type { EntityType } from "../domain/schema/entity-schema.js";
import type { ResolutionOutcome } from "../inference/resolution/resolve-mention.js";

/**
 * The differ's output: a Command, the two Confidences behind it, and the
 * provenance that traces it back to a Capture (`add.md` §5.6).
 *
 * ## The two Confidences stay apart
 *
 * `triage.md` §1 keeps them separate because the failure modes differ: a bad
 * extraction invents a fact that was never in the note, and a bad resolution
 * attaches a real fact to the wrong entity. They combine at triage and nowhere
 * else, which is why this type has two fields rather than one.
 *
 * **A Proposal inspected mid-pipeline carrying a single blended number is a
 * failure** (`qa.md`, Slice 4's verification). There is deliberately no
 * `confidence` accessor here and no constructor that multiplies them — the
 * combination is Slice 5's, done at the moment of triage against thresholds
 * keyed by provider and model version.
 *
 * ## The version stamp
 *
 * `command.aggregate.expectedVersion` carries the version of the aggregate the
 * differ computed against. A Proposal that sits in the review queue for three
 * days while its target changes underneath it fails that check at apply time
 * and is re-proposed against current state rather than applied blindly
 * (`add.md` §5.6). That is the only place in Otto that needs concurrency
 * control, and it needs it because of user think-time rather than parallelism.
 */
export interface Proposal {
  /** Derived from the Capture, stage, provider, model version, and ordinal. */
  readonly proposalId: string;
  readonly captureId: string;
  /**
   * What would change. The differ built it, never the model — which is why it
   * can name neither an invented field nor an id that was never real.
   */
  readonly command: Command;
  readonly confidences: SeparateConfidences;
  /** How resolution reached its decision, which triage's `create` rule reads. */
  readonly resolution: ResolutionSummary;
  /**
   * The entity type the Command targets, which triage reads the per-field
   * disposition floor off `schema.md` with.
   *
   * The Command names an aggregate *id*, and a floor is a property of a field
   * on a *type* — so without this, triage would have to load the entity to find
   * out what kind of thing it is, and `inference/` may not reach for a
   * repository (ADR-0003). The differ already knows the type at the moment it
   * builds the Command, so carrying it costs nothing and keeps triage pure.
   */
  readonly entityType: EntityType;
  /** The model that produced it. Thresholds and bootstrap key on this pair. */
  readonly model: ModelIdentity;
  /** When the Proposal was computed, ISO 8601. */
  readonly proposedAt: string;
}

/**
 * The provider and model version a Proposal was produced under (ADR-0008).
 *
 * On the Proposal rather than looked up at triage time, because a Proposal that
 * sat in the review queue for three days is triaged against **its own** model's
 * thresholds and not against whichever model happens to be configured when it
 * comes back up.
 */
export interface ModelIdentity {
  readonly provider: string;
  readonly modelVersion: string;
}

/**
 * `p(extraction)` and `p(resolution)`, held apart.
 *
 * Two fields on a named type rather than two loose numbers, so that a caller
 * reaching for "the confidence" has to say which one it means and a reviewer
 * can see when someone stops meaning it.
 */
export interface SeparateConfidences {
  /**
   * The model's self-report on whether the claim is what the text said.
   *
   * It has no scorer behind it — ADR-0006's argument is that a self-reported
   * LLM confidence is a token distribution rather than a probability — which is
   * why Slice 5 treats it as a floor rather than as a probability.
   */
  readonly extraction: number;
  /**
   * The scorer's margin between the top two candidates, never the model's
   * self-report (`triage.md` §1).
   *
   * `null` when resolution did not apply: a create has no candidate it was
   * chosen over, and `triage.md` §1's second formula is `p(correct) =
   * p(extraction)` for exactly that case. Null rather than 1 because the two
   * mean different things — 1 would claim a resolution happened and went
   * perfectly.
   */
  readonly resolution: number | null;
}

/**
 * How resolution decided, carried so triage can apply the `create` rule
 * without re-deriving it.
 *
 * `triage.md` §3 splits creates in two: an unambiguous one permits auto-apply,
 * because sending every first-ever mention to review would make the first use
 * of Otto a form to fill in; a create that rejected real candidates downgrades
 * to review, because that decision is the one that manufactures duplicates.
 * The distinction is resolution's to make and triage's to act on, so it travels
 * on the Proposal rather than being recomputed from a number.
 */
export interface ResolutionSummary {
  readonly outcome: ResolutionOutcome;
  /** Whether an adjudicator was asked. Does not change the confidence. */
  readonly wasAdjudicated: boolean;
  /** How many candidates were considered, for the review queue to show. */
  readonly candidateCount: number;
}
