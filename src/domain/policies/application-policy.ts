import { type Disposition, mostRestrictive } from "./disposition.js";
import type { DispositionFloor } from "../schema/field-types.js";

/**
 * **What kinds of change may happen to knowledge without a human looking.**
 *
 * The complete `triage.md` §3 rule table, and the whole of ADR-0007's domain
 * half of triage. It is asked about a *kind of change* and answers with a
 * Disposition it may only make more restrictive.
 *
 * ## Why this is in `domain/` and the thresholds are not
 *
 * The question here stays true whether the proposed change came from an LLM, a
 * regex, or a human typing directly — it is about the user's tolerance for
 * damage to what they know. The question in `inference/calibration/` is "did
 * Otto's pipeline probably get this right", which vanishes the moment you
 * delete Otto (ADR-0002).
 *
 * The rule that settles the placement is `remove`: never, however sure Otto is.
 * A rule that does not read the number it is supposedly about belongs with the
 * rules about knowledge rather than with the numbers.
 *
 * ## It cannot read a number
 *
 * Nothing in this file names the scores triage weighs, and that is enforced
 * twice — by the `domain/` grep in `tests/boundaries/` and by a test on this
 * file's own source (`qa.md` §5.1). The input is a `ChangeKind`, carrying what
 * kind of thing is happening and nothing about how sure anyone is that it
 * should. The prose avoids the word for the same reason the code does: an
 * exemption list is a thing that grows.
 */

/** The kinds of change the table has rows for. */
export const CHANGE_KINDS = [
  "create",
  "update_field",
  "add_relation",
  "remove",
  "merge",
  "split",
] as const;

/**
 * A kind of change, carrying only what the table branches on.
 *
 * A discriminated union rather than one shape with optional fields: the
 * `create` row branches on something no other row has, and an optional flag
 * would let a caller pass a rejected-candidates marker on a `remove`, where it
 * means nothing.
 */
export type ChangeKind =
  | {
      readonly change: "create";
      /**
       * Whether resolution found plausible candidates and decided against all
       * of them — the decision that manufactures duplicate Sarahs.
       */
      readonly hadRejectedCandidates: boolean;
    }
  | {
      readonly change: "update_field";
      /** The field's own floor, read from `schema.md` rather than decided here. */
      readonly floor: DispositionFloor;
    }
  | { readonly change: "add_relation" }
  | { readonly change: "remove" }
  | { readonly change: "merge" }
  | { readonly change: "split" };

/**
 * The Disposition `proposed` is permitted to keep, given what kind of change it
 * is.
 *
 * **May only downgrade.** That is not a convention this function follows; it is
 * a property of returning `mostRestrictive(proposed, …)`, which makes the
 * proposed value a ceiling on the answer. A row added later that returns
 * `auto_apply` for something cannot upgrade a `needs_review` into it.
 */
export function permittedDisposition(proposed: Disposition, kind: ChangeKind): Disposition {
  return mostRestrictive(proposed, ceilingFor(kind));
}

/**
 * The most permissive Disposition this kind of change may ever receive.
 *
 * Reads as the table it is: every row of `triage.md` §3 is one branch, and the
 * three destructive kinds share the last one because they share a reason.
 */
function ceilingFor(kind: ChangeKind): Disposition {
  if (kind.change === "create") return createCeiling(kind.hadRejectedCandidates);
  if (kind.change === "update_field") return floorCeiling(kind.floor);
  if (kind.change === "add_relation") return "auto_apply";
  return "needs_review";
}

/**
 * A create is the one row more permissive than "creates are additive" implies.
 *
 * Unambiguous — candidate generation returned nothing above the noise floor —
 * permits auto-apply, because creating is not a guess when there is no entity
 * this could plausibly be instead. A create made *after* rejecting a real
 * candidate is the decision worth a human glance, and it is cheapest to correct
 * at the moment Otto is deciding to create a second Sarah rather than weeks
 * later.
 */
function createCeiling(hadRejectedCandidates: boolean): Disposition {
  return hadRejectedCandidates ? "needs_review" : "auto_apply";
}

/**
 * The per-field floors of `schema.md` §1, applied rather than restated.
 *
 * `name` on any entity and `became` relations carry `review`, because getting
 * them wrong is expensive in a way a wrong `notes` line is not. The differ
 * carries the floor onto the change; this decides what it means.
 */
function floorCeiling(floor: DispositionFloor): Disposition {
  return floor === "review" ? "needs_review" : "auto_apply";
}
