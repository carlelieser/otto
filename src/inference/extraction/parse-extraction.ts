import { type EntityType, findField, isEntityType } from "../../domain/schema/entity-schema.js";
import { isExtractable } from "../../domain/schema/field-types.js";
import type { FieldValue, Mention, SchemaViolation } from "../../ports/extractor.js";
import { parseFieldValue } from "./parse-field-value.js";
import { ViolationLog } from "./violation-log.js";

/**
 * Model output to Mentions, with everything the schema does not permit dropped
 * and every drop recorded.
 *
 * This is the seam `add.md` §5.2 calls structural: the output schema is
 * generated from `schema.md`, so an unknown field fails here rather than
 * reaching the differ. On the local path the grammar should make that
 * unreachable — this is the second of the two defences, and the reason it
 * exists anyway is that the cloud adapters request structured output by tool
 * use and JSON mode, neither of which constrains a field name the way a grammar
 * does.
 *
 * It is deliberately lenient about *individual* mentions and strict about the
 * envelope. A model that emits one malformed mention among five has produced
 * four usable ones, and discarding them buys nothing; a model that did not emit
 * a mentions array at all has failed in a way no salvage is honest about.
 */
export function parseExtraction(raw: unknown): ParsedExtraction {
  const violations = new ViolationLog();
  const mentions = requireMentionArray(raw)
    .map((mention) => parseMention(mention, violations))
    .filter((mention): mention is Mention => mention !== null);
  return { mentions, violations: violations.recorded() };
}

export interface ParsedExtraction {
  readonly mentions: readonly Mention[];
  readonly violations: readonly SchemaViolation[];
}

/** The envelope, or a throw. Everything past here degrades rather than fails. */
function requireMentionArray(raw: unknown): readonly unknown[] {
  const mentions = (raw as { mentions?: unknown } | null)?.mentions;
  if (!Array.isArray(mentions)) {
    throw new Error(
      `Cannot read extraction output: expected a mentions array, got ${describe(raw)}`,
    );
  }
  return mentions;
}

function describe(raw: unknown): string {
  if (raw === null || typeof raw !== "object") return String(raw);
  return `an object with keys ${Object.keys(raw).join(", ") || "<none>"}`;
}

/**
 * One mention, or `null` when it names no entity type or has no text.
 *
 * The two drops are recorded differently on purpose. An unknown entity type is
 * a **schema violation** — the model named a type the schema does not have,
 * which is the same class of failure as inventing a field name, and
 * `schema.md` §1 requires it to be logged rather than accepted quietly.
 *
 * A mention with no text is not. Nothing about the schema was broken: the model
 * emitted a well-formed Person with no name in it, which is an *empty* answer
 * rather than an invalid one. Counting it against the zero-tolerance violation
 * rate would make that metric measure model verbosity instead of schema
 * compliance (`qa.md` §6.1), and the eval set already catches it — a mention
 * that is dropped is a mention that was not found, so it lands in mention
 * recall, which is exactly where a missed entity belongs.
 */
function parseMention(raw: unknown, violations: ViolationLog): Mention | null {
  const candidate = (raw ?? {}) as RawMention;
  const entityType = readEntityType(candidate, violations);
  const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
  if (entityType === null || text === "") return null;

  const fields = parseFields(candidate.fields, { entityType, violations });
  return { text, entityType, fields, confidence: clampConfidence(candidate.confidence) };
}

interface RawMention {
  readonly text?: unknown;
  readonly entity_type?: unknown;
  readonly fields?: unknown;
  readonly confidence?: unknown;
}

/** The mention's entity type, or `null` with the drop recorded. */
function readEntityType(mention: RawMention, violations: ViolationLog): EntityType | null {
  const declared = mention.entity_type;
  if (isEntityType(declared)) return declared;
  violations.record("unknown_entity_type", "", String(declared ?? ""));
  return null;
}

/**
 * The model's self-report, clamped into [0, 1].
 *
 * Clamped rather than rejected because it is not a probability — ADR-0006's
 * argument is that it is a token distribution — so a model reporting 1.2 has
 * said "very confident" in a malformed way rather than said nothing. Slice 5
 * treats it as a floor, and a floor outside its range would silently disable
 * the threshold it feeds. A non-numeric value becomes the neutral midpoint,
 * which routes to review rather than to auto-apply.
 */
const UNSTATED_CONFIDENCE = 0.5;

function clampConfidence(raw: unknown): number {
  if (typeof raw !== "number" || Number.isNaN(raw)) return UNSTATED_CONFIDENCE;
  return Math.min(1, Math.max(0, raw));
}

interface FieldContext {
  readonly entityType: EntityType;
  readonly violations: ViolationLog;
}

/** Every permitted field value on one mention, in the order the model emitted them. */
function parseFields(raw: unknown, field: FieldContext): readonly FieldValue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => parseOneField(entry, field));
}

/**
 * One emitted field: kept, dropped with a violation, or expanded.
 *
 * Expansion is the enum escape hatch — a value outside a closed set becomes
 * `other` plus a `notes` entry (`schema.md` §7), which is two field values from
 * one emitted field and the reason this returns an array.
 */
function parseOneField(raw: unknown, { entityType, violations }: FieldContext): FieldValue[] {
  const { field, value } = (raw ?? {}) as { field?: unknown; value?: unknown };
  const name = typeof field === "string" ? field : "";
  const definition = findField(entityType, name);
  if (definition === undefined) return dropUnknown(name, entityType, violations);
  if (!isExtractable(definition)) return dropDerived(name, entityType, violations);
  return parseFieldValue(definition, value);
}

/**
 * A field name the schema does not have. On the local path the grammar should
 * make this unreachable, which `qa.md` §7.2 asks be tested rather than assumed.
 */
function dropUnknown(name: string, entityType: EntityType, violations: ViolationLog): FieldValue[] {
  violations.record("unknown_field", name, entityType);
  return [];
}

/**
 * A field computed by projection. `schema.md` §1 requires both halves of this:
 * the drop, and that the drop is **logged as a schema violation, not accepted
 * quietly**.
 */
function dropDerived(name: string, entityType: EntityType, violations: ViolationLog): FieldValue[] {
  violations.record("derived_field", name, entityType);
  return [];
}
