import { describe, expect, it } from "vitest";
import { ENTITY_SCHEMA, ENTITY_TYPES } from "../../src/domain/schema/entity-schema.js";
import { DATE_PRECISIONS } from "../../src/domain/values/resolved-date.js";
import { outputSchema } from "../../src/inference/extraction/output-schema.js";
import { toGbnf } from "../../src/inference/extraction/to-gbnf.js";
import { toJsonSchema } from "../../src/inference/extraction/to-json-schema.js";

/**
 * The output schema is **generated from `schema.md`**, not hand-written beside
 * it (`add.md` §5.2). These tests pin the property that generation buys: the
 * model is asked only for fields the schema declares, in both dialects, without
 * anyone maintaining a second list.
 */

const SCHEMA = outputSchema();

describe("the generated output schema", () => {
  it("covers every entity type", () => {
    expect(SCHEMA.entityTypes.map(({ entityType }) => entityType)).toEqual([...ENTITY_TYPES]);
  });

  /**
   * The half that makes derived fields structurally impossible on both cloud
   * paths as well as the local one: `salience` is not merely rejected after the
   * fact, it is never asked for.
   */
  it("excludes derived fields from every entity type", () => {
    for (const { fields } of SCHEMA.entityTypes) {
      expect(fields.map(({ name }) => name)).not.toContain("salience");
    }
    const person = SCHEMA.entityTypes.find(({ entityType }) => entityType === "Person")!;
    expect(person.fields.map(({ name }) => name)).not.toContain("last_contact_at");
  });

  it("includes every extractable field of every entity type", () => {
    for (const { entityType, fields } of SCHEMA.entityTypes) {
      const extractable = ENTITY_SCHEMA[entityType].filter(
        (field) => field.extractability === "extractable",
      );
      expect(fields).toHaveLength(extractable.length);
    }
  });
});

describe("the GBNF grammar", () => {
  const grammar = toGbnf(SCHEMA);

  it("names a production for every entity type", () => {
    for (const entityType of ENTITY_TYPES) {
      expect(grammar).toContain(`mention-${entityType.toLowerCase()}`);
    }
  });

  /**
   * The mechanism, stated as a test: a field name is a literal in the grammar,
   * so emitting one that is not there would mean sampling a token sequence no
   * production reaches.
   */
  it("pins every extractable field name as a literal", () => {
    for (const { fields } of SCHEMA.entityTypes) {
      for (const field of fields) expect(grammar).toContain(`\\"${field.name}\\"`);
    }
  });

  it("does not name a derived field anywhere", () => {
    expect(grammar).not.toContain("salience");
    expect(grammar).not.toContain("last_contact_at");
  });

  /**
   * `schema.md` §7's closed enums, rendered as literal alternatives — which is
   * what makes an out-of-set value unreachable on the local path rather than
   * something the parser rewrites afterwards.
   */
  it("renders each closed enum's members as literal alternatives", () => {
    for (const value of ["colleague", "acquaintance", "abandoned", "milestone", "dropped"]) {
      expect(grammar).toContain(`\\"${value}\\"`);
    }
  });

  it("offers every date precision, including `relative_unresolved`", () => {
    for (const precision of DATE_PRECISIONS) expect(grammar).toContain(`\\"${precision}\\"`);
  });

  /** GBNF rule names take no underscores, so `next_action` becomes `next-action`. */
  it("renders rule names without underscores", () => {
    const ruleNames = [...grammar.matchAll(/^(\S+)\s*::=/gmu)].map((match) => match[1]!);

    expect(ruleNames.length).toBeGreaterThan(10);
    expect(ruleNames.filter((name) => name.includes("_"))).toEqual([]);
  });
});

describe("the JSON Schema", () => {
  const schema = toJsonSchema(SCHEMA) as {
    properties: { mentions: { items: { anyOf: MentionSchema[] } } };
  };

  interface MentionSchema {
    properties: {
      entity_type: { const: string };
      fields: { items: { anyOf: { properties: { field: { const: string } } }[] } };
    };
  }

  it("offers one variant per entity type", () => {
    const variants = schema.properties.mentions.items.anyOf;

    expect(variants.map((variant) => variant.properties.entity_type.const)).toEqual([
      ...ENTITY_TYPES,
    ]);
  });

  /**
   * Per-type rather than a flattened union of every field name: `employer` on a
   * Project is as wrong as `shoe_size` on a Person, and a flat schema would
   * accept it.
   */
  it("scopes each type's fields to that type", () => {
    const project = schema.properties.mentions.items.anyOf.find(
      (variant) => variant.properties.entity_type.const === "Project",
    )!;
    const names = project.properties.fields.items.anyOf.map(
      (field) => field.properties.field.const,
    );

    expect(names).toContain("status");
    expect(names).not.toContain("employer");
  });

  it("excludes derived fields", () => {
    const everyField = schema.properties.mentions.items.anyOf.flatMap((variant) =>
      variant.properties.fields.items.anyOf.map((field) => field.properties.field.const),
    );

    expect(everyField).not.toContain("salience");
    expect(everyField).not.toContain("last_contact_at");
  });

  /**
   * Both renderers read the same `OutputSchema`, which is what keeps the three
   * providers from being asked for different things. This is the test that they
   * have not drifted.
   */
  it("names the same fields the grammar does", () => {
    const grammar = toGbnf(SCHEMA);
    const everyField = schema.properties.mentions.items.anyOf.flatMap((variant) =>
      variant.properties.fields.items.anyOf.map((field) => field.properties.field.const),
    );

    for (const name of new Set(everyField)) expect(grammar).toContain(`\\"${name}\\"`);
  });
});
