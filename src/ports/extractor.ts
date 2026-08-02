import type { EntityType } from "../domain/schema/entity-schema.js";
import type { ResolvedDate } from "../domain/values/resolved-date.js";

/**
 * A Capture's text in, structured Mentions and the values claimed about them
 * out (`add.md` §9).
 *
 * It reads *nothing but the text* — no database access, no entity list, no
 * prior knowledge of who Sarah is (`add.md` §5.2). That constraint is not an
 * implementation detail: it is what makes extraction testable against a fixed
 * corpus with fixed expected output, and therefore what makes the eval set
 * possible at all. A stage that read current state would have correct output
 * that changes as the database does, and no corpus could pin it. **Any future
 * change letting extraction peek at the entity list destroys the eval set as an
 * instrument** and is a breaking architectural change rather than an
 * optimisation (`qa.md` §6.1).
 *
 * ADR-0008's test holds here: nothing in this signature mentions `temperature`,
 * `max_tokens`, or `messages[]`, because a port naming those is a vendor-shaped
 * port wearing a generic name. Nothing in it knows an LLM is involved at all,
 * which is exactly what lets a fully local runtime satisfy it.
 */
export interface Extractor {
  /**
   * The Mentions and field values `request.text` claims, with dates resolved
   * against `request.capturedAt`.
   *
   * Returns an empty `mentions` array for a note with no extractable entity —
   * a valid outcome that must not produce a spurious Proposal (`qa.md` §6.2),
   * and the reason this returns a result rather than throwing on nothing found.
   *
   * Throws when the model is unreachable or its output cannot be parsed. An
   * unavailable provider leaves Captures accumulating (`add.md` §11), which is
   * a state the pipeline already handles; a caller that could not tell that
   * apart from "the note said nothing" would durably record silence as fact.
   */
  extract(request: ExtractionRequest): Promise<Extraction>;
}

/** Everything the extractor is given, and deliberately nothing more. */
export interface ExtractionRequest {
  /**
   * The Capture's normalised text. The corrected transcript once Slice 9
   * writes one, which is why this is text rather than a Capture id — a port
   * taking an id would need a store to read it, and reading is what §5.2
   * forbids.
   */
  readonly text: string;
  /**
   * The Capture's `sourceTimestamp`, ISO 8601 UTC — the instant relative dates
   * resolve against (`schema.md` §8).
   *
   * The one piece of context beyond the text, and it is not a database read:
   * it travels with the note rather than being looked up, so the corpus stays
   * fixed and the output stays reproducible.
   */
  readonly capturedAt: string;
}

/** What one extraction produced, and what produced it. */
export interface Extraction {
  readonly mentions: readonly Mention[];
  /**
   * The adapter's provider, e.g. `local`, `anthropic`, `openai`. Recorded on
   * everything produced and folded into `proposal_id` (`runtime.md` §3), so a
   * re-run under a better model produces new Proposals rather than no-ops.
   */
  readonly provider: string;
  /** The model, exactly as the provider names it. Triage thresholds key on it. */
  readonly modelVersion: string;
  /**
   * Fields the model emitted that the schema does not permit, dropped rather
   * than passed on.
   *
   * Present on the result rather than logged and forgotten because
   * `schema.md` §1 requires the drop to be **logged as a schema violation, not
   * accepted quietly**, and because the rate is a metric the eval set reports
   * with zero tolerance (`qa.md` §6.1). A number nothing carries is a number
   * nothing can measure.
   */
  readonly violations: readonly SchemaViolation[];
}

/**
 * An entity as it appeared in the note, and the values claimed about it.
 *
 * A Mention is not an entity. Which entity it refers to is resolution's
 * question, one stage later, with a different confidence behind it — this
 * carries only what the text said.
 */
export interface Mention {
  /** The name as it appeared in the text, not normalised to a canonical form. */
  readonly text: string;
  readonly entityType: EntityType;
  /** The field values claimed about this Mention, keyed by field name. */
  readonly fields: readonly FieldValue[];
  /**
   * The model's self-reported `p(extraction)`, in [0, 1].
   *
   * Kept separate from resolution's confidence throughout (`triage.md` §1). It
   * has no scorer behind it — ADR-0006's argument is that a self-reported LLM
   * confidence is a token distribution rather than a probability — which is why
   * Slice 5 treats it as a floor rather than as a probability.
   */
  readonly confidence: number;
}

/** One field value claimed about a Mention. */
export interface FieldValue {
  /** A field name from `schema.md`'s tables. An unknown name never reaches here. */
  readonly field: string;
  /**
   * The value, typed by the field's declared type: a `date` field carries a
   * `ResolvedDate`, everything else a string.
   *
   * A `set` field contributes one `FieldValue` per member rather than an array,
   * so the differ's union has members to union rather than a list to diff.
   */
  readonly value: string | ResolvedDate;
}

/** A field the model emitted that the schema does not permit. */
export interface SchemaViolation {
  /** Which rule the emitted field broke. */
  readonly reason: SchemaViolationReason;
  /** The field name as the model emitted it. */
  readonly field: string;
  /** The entity type it was emitted against, when the model named a valid one. */
  readonly entityType: string;
}

/**
 * The three ways an emitted field fails the schema.
 *
 * `unknown_field` should be structurally impossible on a grammar-constrained
 * path — the output schema is generated from `schema.md`, so an unknown name
 * fails parsing before the differ (`schema.md` §7). It is enumerated anyway
 * because "should be impossible" is a claim a test has to be able to make, and
 * because the cloud adapters request structured output by other means.
 */
export const SCHEMA_VIOLATION_REASONS = [
  "unknown_field",
  "derived_field",
  "unknown_entity_type",
] as const;

export type SchemaViolationReason = (typeof SCHEMA_VIOLATION_REASONS)[number];
