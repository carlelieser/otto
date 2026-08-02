import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENTITY_TYPES, type EntityType } from "../../src/domain/schema/entity-schema.js";
import {
  RELATION_NAMES,
  RELATION_SCHEMA,
  type RelationName,
  findRelation,
  isRelationName,
  relationViolations,
} from "../../src/domain/schema/relation-schema.js";

/**
 * The Relation table is pinned against `schema.md` §6 for the same reason the
 * field tables are: it was transcribed by hand, everything downstream reads it,
 * and a wrong type pair is a graph edge nothing else would refuse.
 *
 * The vocabulary being closed is the property under test (ADR-0014). An open
 * set means Extraction invents relation names and the graph fragments into
 * `works_on`, `working_on`, and `involved_with` meaning one thing.
 */

const SCHEMA_DOCUMENT = resolve(import.meta.dirname, "../../docs/schema.md");

/** `| \`name\` | From → To | cardinality | notes |` */
const RELATION_ROW =
  /^\|\s*`(?<name>[a-z_]+)`\s*\|\s*(?<pairs>[^|]+?)\s*\|\s*(?<cardinality>single|set)\s*\|/;

interface DocumentedRelation {
  readonly name: string;
  readonly pairs: string;
  readonly cardinality: string;
}

/** Every relation row in `schema.md` §6, keyed by name. */
async function documentedRelations(): Promise<Map<string, DocumentedRelation>> {
  const document = await readFile(SCHEMA_DOCUMENT, "utf8");
  const section = document.slice(
    document.indexOf("## 6. Relations"),
    document.indexOf("## 7. Two rules"),
  );

  const relations = new Map<string, DocumentedRelation>();
  for (const line of section.split("\n")) {
    const match = RELATION_ROW.exec(line.trim());
    if (match?.groups === undefined) continue;
    const { name, pairs, cardinality } = match.groups;
    relations.set(name!, { name: name!, pairs: pairs!, cardinality: cardinality! });
  }
  return relations;
}

/**
 * §6's pair column, parsed.
 *
 * A clause with an arrow starts a new `from`; one without inherits the previous
 * one, which is how §6 writes `Task → Person, Project, Idea, Event` — one
 * `from` followed by several `to` types sharing it.
 */
function documentedPairs(pairs: string): { from: string; to: string }[] {
  const clauses = pairs.split(",").map((clause) => clause.trim());
  const parsed: { from: string; to: string }[] = [];
  let currentFrom = "";
  for (const clause of clauses) {
    if (clause.includes("→")) {
      const [from, to] = clause.split("→").map((side) => side.trim());
      currentFrom = from!;
      parsed.push({ from: currentFrom, to: to! });
      continue;
    }
    parsed.push({ from: currentFrom, to: clause });
  }
  return parsed;
}

describe("the relation vocabulary", () => {
  it("declares every relation `schema.md` §6 documents, and no other", async () => {
    const documented = await documentedRelations();

    expect([...documented.keys()].sort()).toEqual([...RELATION_NAMES].sort());
  });

  it("matches the documented cardinality of every relation", async () => {
    const documented = await documentedRelations();

    for (const name of RELATION_NAMES) {
      expect(findRelation(name).cardinality, `${name} cardinality`).toBe(
        documented.get(name)!.cardinality,
      );
    }
  });

  it("matches the documented from→to type pairs of every relation", async () => {
    const documented = await documentedRelations();

    for (const name of RELATION_NAMES) {
      const expected = documentedPairs(documented.get(name)!.pairs);
      const declared = findRelation(name).pairs.map(({ from, to }) => ({ from, to }));
      expect(declared, `${name} pairs`).toEqual(expected);
    }
  });

  /**
   * §6's own example of the constraint doing its job. A `knows` between a
   * Person and a Project is not a typo the graph should absorb — it is the
   * failure the type pairs exist to refuse.
   */
  it("rejects a `knows` between a Person and a Project", () => {
    const violations = relationViolations({ name: "knows", from: "Person", to: "Project" });

    expect(violations).not.toEqual([]);
  });

  it("accepts a `knows` between two People", () => {
    expect(relationViolations({ name: "knows", from: "Person", to: "Person" })).toEqual([]);
  });

  /**
   * Exhaustive rather than by example: for every relation and every pair of
   * entity types, the schema accepts exactly the pairs §6 declares. An
   * implementation that accepted a superset would pass the two tests above.
   */
  it("accepts exactly its declared pairs and refuses every other combination", () => {
    for (const name of RELATION_NAMES) {
      const declared = new Set(findRelation(name).pairs.map(({ from, to }) => `${from}→${to}`));
      for (const from of ENTITY_TYPES) {
        for (const to of ENTITY_TYPES) {
          const isDeclared = declared.has(`${from}→${to}`);
          const isAccepted = relationViolations({ name, from, to }).length === 0;
          expect(isAccepted, `${name}: ${from}→${to}`).toBe(isDeclared);
        }
      }
    }
  });

  it("makes `became` the only single-cardinality relation", () => {
    const single = RELATION_NAMES.filter((name) => findRelation(name).cardinality === "single");

    expect(single).toEqual(["became"]);
  });

  /**
   * `became` is a supersession of one entity by another and sits closer to
   * merge than to an ordinary edge (`schema.md` §6), so it never auto-applies.
   */
  it("gives `became` a review floor and every other relation an auto floor", () => {
    for (const name of RELATION_NAMES) {
      const expected = name === "became" ? "review" : "auto";
      expect(findRelation(name).floor, `${name} floor`).toBe(expected);
    }
  });

  it("recognises only the seven documented names", () => {
    expect(isRelationName("works_on")).toBe(false);
    expect(isRelationName("involves")).toBe(true);
  });

  it("refuses a relation name outside the vocabulary", () => {
    const violations = relationViolations({
      name: "works_on" as RelationName,
      from: "Project",
      to: "Person",
    });

    expect(violations).not.toEqual([]);
  });

  it("refuses an entity type outside the five", () => {
    const violations = relationViolations({
      name: "involves",
      from: "Meeting" as EntityType,
      to: "Person",
    });

    expect(violations).not.toEqual([]);
  });

  it("declares a pair for every relation", () => {
    for (const name of RELATION_NAMES) {
      expect(RELATION_SCHEMA[name].pairs.length, `${name} pairs`).toBeGreaterThan(0);
    }
  });
});
