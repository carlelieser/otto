import { ENTITY_TYPES } from "../../../domain/schema/entity-schema.js";
import { extractableFields } from "../../../inference/extraction/output-schema.js";
import type { ExtractionRequest } from "../../../ports/extractor.js";

/**
 * The one extraction prompt, shared by all three adapters.
 *
 * ADR-0008 accepts a cost and names this as the mitigation: task-shaped ports
 * mean the prompt lives per adapter, so three providers means three copies
 * drifting apart. This file is where that does not happen. Per-adapter
 * differences are confined to *how* structured output is requested — tool use,
 * JSON mode, or grammar constraints — which genuinely do differ; *what* is
 * asked for does not.
 *
 * The field list is generated from `schema.md`'s tables rather than written
 * out, for the same reason the output schema is: a prompt naming fields by hand
 * is a third declaration to keep in step, and the one nothing would fail on.
 */
export function extractionPrompt(request: ExtractionRequest): string {
  return [
    ROLE,
    entityTypeGuide(),
    dateGuide(request.capturedAt),
    ENUM_GUIDE,
    CONFIDENCE_GUIDE,
    `Note, captured at ${request.capturedAt}:\n${request.text}`,
  ].join("\n\n");
}

/**
 * What the model is being asked for, and the constraint that defines the stage.
 *
 * "Only what this note says" is the prompt-level statement of `add.md` §5.2's
 * rule that extraction reads nothing but the text. The model has no database to
 * read from, so this guards against the other direction: inferring from world
 * knowledge that a named company is an employer, or that two names in one note
 * must know each other.
 */
const ROLE = `You extract structured knowledge from a personal note.

Return the entities the note mentions and the field values it states about them.
Extract only what this note says. Do not infer facts it does not state, and do
not add what you know about a name from anywhere else. A note that mentions
nothing worth recording yields an empty list, which is a correct answer.

Use the name exactly as the note wrote it. Do not expand, correct, or
canonicalise it — a later stage decides which known entity it refers to, and it
needs the original wording to do that.`;

/** The five entity types and the fields each may claim, straight from the schema. */
function entityTypeGuide(): string {
  const types = ENTITY_TYPES.map(
    (entityType) =>
      `- ${entityType}: ${extractableFields(entityType)
        .map((field) => field.name)
        .join(", ")}`,
  );
  return `Entity types, and the only fields each may carry:\n${types.join("\n")}`;
}

/**
 * `schema.md` §8. The Capture timestamp is given as context and dates come back
 * absolute, each with a precision marker — because "sometime next quarter" and
 * "on the 4th" must not become indistinguishable timestamps.
 *
 * `relative_unresolved` is spelled out as an acceptable answer rather than left
 * implicit. A model given six precisions and no permission to fail will pick a
 * date for "when the contract lands", and an invented timestamp is worse than
 * an honest absence.
 */
function dateGuide(capturedAt: string): string {
  return `Dates: the note was captured at ${capturedAt}. Resolve every relative date
against that instant and return it absolute, as ISO 8601 UTC, with a precision
marker saying how precisely the note stated it:

- exact: a date and time were both given
- day, month, quarter, year: the note pinned it only that far
- relative_unresolved: the note tied it to an event rather than a date, as in
  "when the contract lands". Return no timestamp at all for these.

Always return the phrase the note used, whatever the precision.`;
}

/**
 * `schema.md` §7's pressure valve, stated so the model uses it deliberately.
 *
 * The second paragraph is what makes the valve work. Without it, a fact that
 * fits no typed field is dropped, and a schema that cannot express "Sarah is
 * allergic to shellfish" should still not throw the sentence away.
 */
const ENUM_GUIDE = `Fields with a fixed set of values accept only those values. When the note means
something outside the set, use "other" and put the specific wording in a notes
entry.

Anything true about an entity that no listed field can hold belongs in notes.
Do not invent a field name for it and do not drop it.`;

/**
 * The self-report, and an instruction to make it mean something.
 *
 * ADR-0006's argument is that this is a token distribution rather than a
 * probability, which is why Slice 5 treats it as a floor. Asking for it anyway
 * is worth the tokens because a *low* self-report is informative even when a
 * high one is not — and the calibration curve (`qa.md` §6.1) is what checks
 * which.
 */
const CONFIDENCE_GUIDE = `Give each entity a confidence between 0 and 1: how sure you are that the note
actually says this, not how plausible it sounds. Lower it when the note is
ambiguous, abbreviated, or looks mis-transcribed.`;
