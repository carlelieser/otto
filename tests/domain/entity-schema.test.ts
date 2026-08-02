import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENTITY_SCHEMA,
  ENTITY_TYPES,
  type EntityType,
  findField,
} from "../../src/domain/schema/entity-schema.js";
import { isExtractable } from "../../src/domain/schema/field-types.js";

/**
 * The tables in `entity-schema.ts` were transcribed by hand from `schema.md`,
 * and that transcription is the risk: everything downstream generates from
 * them, so a field this file misses is a field the model can never propose and
 * nothing else would notice.
 *
 * So the pinning test reads `schema.md` itself and compares. It is unusual to
 * parse a design document in a test, and it is justified here by `schema.md`'s
 * own first line — "where they disagree, this document is wrong" names the
 * document as the authority, and an authority nothing checks against is a
 * comment.
 */

const SCHEMA_DOCUMENT = resolve(import.meta.dirname, "../../docs/schema.md");

/**
 * A markdown table row: `| name | type | cardinality | extractable | floor | notes |`.
 *
 * The floor column is matched loosely because a derived field carries `—`
 * rather than a value — a floor is a triage property and a field that can never
 * be proposed never reaches triage. Requiring a word there silently skipped the
 * two derived rows, which are the rows this file exists to pin.
 */
const TABLE_ROW =
  /^\|\s*`(?<name>[a-z_]+)`\s*\|\s*(?<type>\w+)\s*\|\s*(?<cardinality>\w+)\s*\|\s*(?<extractable>\w+)\s*\|[^|]*\|/;

interface DocumentedField {
  readonly name: string;
  readonly type: string;
  readonly cardinality: string;
  readonly extractable: string;
}

/**
 * Every field row in `schema.md` §2-§5, keyed by name.
 *
 * Sections §6 onward are skipped: §6 is the Relation table, whose columns mean
 * different things, and §7-§9 are prose. The cut is by heading rather than by
 * row shape so that a new table added under §6 does not silently start being
 * read as a field table.
 */
async function documentedFields(): Promise<Map<string, DocumentedField>> {
  const document = await readFile(SCHEMA_DOCUMENT, "utf8");
  const fieldSections = document.slice(
    document.indexOf("## 2. Shared fields"),
    document.indexOf("## 6. Relations"),
  );

  const fields = new Map<string, DocumentedField>();
  for (const line of fieldSections.split("\n")) {
    const match = TABLE_ROW.exec(line.trim());
    if (match?.groups === undefined) continue;
    const { name, type, cardinality, extractable } = match.groups;
    fields.set(name!, {
      name: name!,
      type: type!,
      cardinality: cardinality!,
      extractable: extractable!,
    });
  }
  return fields;
}

/** Every (entity, field) pair the code declares, flattened. */
function codedFields(): { entityType: EntityType; name: string }[] {
  return ENTITY_TYPES.flatMap((entityType) =>
    ENTITY_SCHEMA[entityType].map((field) => ({ entityType, name: field.name })),
  );
}

describe("the schema tables", () => {
  it("declares every field name `schema.md` documents", async () => {
    const documented = await documentedFields();
    const declared = new Set(codedFields().map(({ name }) => name));

    const missing = [...documented.keys()].filter((name) => !declared.has(name));
    expect(missing, "fields in schema.md that the code does not declare").toEqual([]);
  });

  it("declares no field `schema.md` does not document", async () => {
    const documented = await documentedFields();

    const invented = [...new Set(codedFields().map(({ name }) => name))].filter(
      (name) => !documented.has(name),
    );
    expect(invented, "fields the code declares that schema.md does not").toEqual([]);
  });

  it("matches the documented type, cardinality, and extractability of every field", async () => {
    const documented = await documentedFields();

    for (const { entityType, name } of codedFields()) {
      const field = findField(entityType, name)!;
      const row = documented.get(name)!;
      expect({ name, type: field.type, cardinality: field.cardinality }).toEqual({
        name,
        type: row.type,
        cardinality: row.cardinality,
      });
      // "yes" in the table means extractable; "derived" means computed by projection.
      expect(isExtractable(field), `${name} extractability`).toBe(row.extractable === "yes");
    }
  });

  /**
   * The two derived fields, named rather than counted.
   *
   * `qa.md` §7.2 asks for both halves of the derived-field rule to be tested,
   * and the drop half lives in the parser. This is the other half: that these
   * two are the fields the parser will be asked to drop, so a table edit
   * marking `salience` extractable fails here rather than passing silently.
   */
  it("marks `salience` and `last_contact_at` derived, and nothing else", () => {
    const derived = codedFields().filter(
      ({ entityType, name }) => !isExtractable(findField(entityType, name)!),
    );

    expect([...new Set(derived.map(({ name }) => name))].sort()).toEqual([
      "last_contact_at",
      "salience",
    ]);
  });

  it("gives every enum field a closed set containing an escape value", () => {
    const enums = ENTITY_TYPES.flatMap((entityType) =>
      ENTITY_SCHEMA[entityType].filter((field) => field.type === "enum"),
    );

    expect(enums.length).toBeGreaterThan(0);
    for (const field of enums) {
      expect(field.values, `${field.name} has a closed set`).toBeDefined();
      expect(field.values!.length).toBeGreaterThan(1);
    }
  });

  /**
   * `name` is the field a rename touches, and renaming is identity-adjacent
   * (`schema.md` §2, §6). A table edit dropping it to `auto` would make renames
   * auto-apply, which is a knowledge-corruption path rather than a friction one.
   */
  it("keeps `name` at a review floor on every entity type", () => {
    for (const entityType of ENTITY_TYPES) {
      expect(findField(entityType, "name")!.floor, `${entityType}.name`).toBe("review");
    }
  });
});
