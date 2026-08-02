import type { Command } from "../commands/command.js";
import { isNonEmptyText } from "../values/text.js";

/**
 * **What the user chose instead** (ADR-0006, `add.md` §7, PRD §5.5).
 *
 * When the user says "that's a different Sarah," Otto stores the Sarah they
 * chose — attached to the Proposal that got it wrong and the Capture behind it
 * — rather than a rejection flag. That is the whole decision, and it is the one
 * ADR-0006 calls nearly free now and unreconstructable later.
 *
 * ## Why the counterfactual is a Command
 *
 * The thing the user chose has to be expressible for every kind of entry the
 * queue produces: a different entity for a mis-resolved Mention, a different
 * value for a mis-read field, a different name for a create. A Command is
 * already exactly that vocabulary (`knowledge-commands.ts`), it is already
 * closed, and it is already what the executor takes — so the corrected answer
 * is *applied* by the same path that applies any other change rather than by a
 * second one that would have to be kept in step.
 *
 * A bespoke shape here would be a third vocabulary of change beside Commands
 * and events, and the first thing it would need is a way to say "set this field
 * to that value."
 *
 * ## There is no rejection here, and that is the point
 *
 * A boolean approved/rejected says the answer was wrong and not what right
 * looked like, and every downstream use needs the latter: the eval set is
 * input/correct-output pairs, the calibration curve asks how often 0.85 was
 * right, and in-context examples retrieve past corrections into the prompt. A
 * year of thumbs-down data supports none of them.
 *
 * So there is no field on this type a rejection could be recorded in, and a
 * test asserts the absence rather than trusting this paragraph.
 *
 * ## Why it lives in `domain/`
 *
 * A Correction is a revision of belief rather than a repair of an error
 * (PRD §5.5) — "Atlas is a project, not a person" is simply a fact about what
 * the user knows, and it would still be one if a human rather than a threshold
 * had got it wrong first. It carries no figure about how sure anyone was, for
 * the same reason nothing else here does (ADR-0002): such a figure describes
 * the inference that was corrected, and it already travels on the Proposal.
 */
export interface Correction {
  /** Derived from the Proposal and the chosen Command, so a retry is a no-op. */
  readonly correctionId: string;
  /** The Proposal that got it wrong. */
  readonly proposalId: string;
  /** The Capture behind it, so a correction is traceable to what was said. */
  readonly captureId: string;
  /**
   * **What the user chose instead.** Never absent, never a flag.
   *
   * The Command that expresses the right answer, which the executor applies
   * directly (`add.md` §7) rather than sending back through the pipeline.
   */
  readonly chosen: Command;
  /** When the user corrected it, ISO 8601. */
  readonly correctedAt: string;
}

/**
 * Whether `chosen` is a Command that actually names a change.
 *
 * The runtime half of the schema decision, and it checks the *shape* rather
 * than mere presence: a `chosen` that arrived as `{}`, as a string, or as
 * `true` is a rejection flag wearing the right type name, which is exactly what
 * ADR-0006 rules out. Presence alone would accept all three.
 *
 * It is here rather than at the transport because what makes a counterfactual a
 * counterfactual is a question about corrections, and the sidecar is one caller
 * of the answer rather than the place it is decided.
 */
export function isCounterfactual(chosen: unknown): chosen is Command {
  if (typeof chosen !== "object" || chosen === null) return false;
  const { type, aggregate } = chosen as Partial<Command>;
  return isNonEmptyText(type) && namesATarget(aggregate);
}

/** A Command has to say which aggregate it changes, and at which version. */
function namesATarget(aggregate: Command["aggregate"] | undefined): boolean {
  if (typeof aggregate !== "object" || aggregate === null) return false;
  return isNonEmptyText(aggregate.id) && Number.isInteger(aggregate.expectedVersion);
}

const REQUIRED_TEXT_FIELDS = ["correctionId", "proposalId", "captureId", "correctedAt"] as const;

/**
 * Why a Correction is not well-formed, or empty if it is.
 *
 * `chosen` is checked alongside the text fields rather than trusted to the type
 * system, for the reason `isCounterfactual` exists: the boundary this crosses
 * is a JSON-RPC one.
 */
export function correctionViolations(correction: Correction): readonly string[] {
  const missing = REQUIRED_TEXT_FIELDS.filter((field) => !isNonEmptyText(correction[field]));
  return isCounterfactual(correction.chosen) ? missing : [...missing, "chosen"];
}
