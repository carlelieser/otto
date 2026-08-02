import type { EntityValue } from "./entity.js";

/**
 * One field value claimed about a Mention, before anything has decided whether
 * it is a change.
 *
 * ## Why this is in `domain/` rather than on the extractor port
 *
 * It was on `ports/extractor.ts`, which is where extraction produces it — and
 * that made the differ import a model-facing port to name the type of its own
 * input. The import was type-only and harmless in itself, and it still broke
 * the property `add.md` §5.4 rests on: **the differ is the one stage with no
 * model in it**, and "the model never emits a Command" is structural only while
 * the code that builds Commands cannot see the code that talks to a model.
 *
 * A claimed value is not a model artefact anyway. It is "someone asserts this
 * field holds this value", which is a statement about knowledge that would
 * still make sense if a human typed it — the ADR-0002 test. So it lives here
 * and both sides name it from the same place.
 */
export interface ClaimedValue {
  /** A field name from `schema.md`'s tables. An unknown name never reaches here. */
  readonly field: string;
  /**
   * The value, typed by the field's declared type: a `date` field carries a
   * `ResolvedDate`, everything else a string.
   *
   * A `set` field contributes one `ClaimedValue` per member rather than an
   * array, so the differ's union has members to union rather than a list to
   * diff.
   */
  readonly value: EntityValue;
}
