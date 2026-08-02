import { describe, expect, it } from "vitest";
import { isSameValue, singleValueOf, valuesOf } from "../../src/domain/knowledge/entity.js";
import { anEntity } from "../support/knowledge-builders.js";

describe("reading an entity's fields", () => {
  it("returns the values a field holds", () => {
    const entity = anEntity({ fields: { contact: ["sarah@example.com", "@sarah"] } });

    expect(valuesOf(entity, "contact")).toEqual(["sarah@example.com", "@sarah"]);
  });

  /**
   * Empty rather than `undefined`, because every caller wants to iterate it and
   * a caller that has to check for absence first is a caller that will forget.
   */
  it("returns empty for a field holding nothing", () => {
    expect(valuesOf(anEntity(), "employer")).toEqual([]);
  });

  it("returns the one value of a single field", () => {
    const entity = anEntity({ fields: { employer: ["Acme"] } });

    expect(singleValueOf(entity, "employer")).toBe("Acme");
  });

  it("returns undefined for a single field holding nothing", () => {
    expect(singleValueOf(anEntity(), "employer")).toBeUndefined();
  });
});

describe("comparing two stored values", () => {
  it("compares text by equality", () => {
    expect(isSameValue("Acme", "Acme")).toBe(true);
    expect(isSameValue("Acme", "Globex")).toBe(false);
  });

  /**
   * `schema.md` §8: "sometime next quarter" and "on the 4th" can resolve to the
   * same instant and are not the same value. Comparing on the timestamp alone
   * would make a precision correction a no-op the differ silently drops.
   */
  it("treats two dates at one instant but different precisions as different", () => {
    const instant = "2026-07-01T00:00:00.000Z";
    const exact = { timestamp: instant, precision: "day", phrase: "the 1st" } as const;
    const coarse = { timestamp: instant, precision: "quarter", phrase: "next quarter" } as const;

    expect(isSameValue(exact, coarse)).toBe(false);
  });

  /**
   * The phrase is what the note said. Two notes saying "Tuesday" and "next
   * Tuesday" about one instant at one precision are claiming the same thing,
   * and treating them as different would produce a Command per retelling.
   */
  it("ignores the phrase when the instant and precision agree", () => {
    const instant = "2026-08-04T00:00:00.000Z";
    const said = { timestamp: instant, precision: "day", phrase: "Tuesday" } as const;
    const retold = { timestamp: instant, precision: "day", phrase: "next Tuesday" } as const;

    expect(isSameValue(said, retold)).toBe(true);
  });

  it("treats a date and a string as different", () => {
    const date = {
      timestamp: "2026-08-04T00:00:00.000Z",
      precision: "day",
      phrase: "Tue",
    } as const;

    expect(isSameValue(date, "2026-08-04T00:00:00.000Z")).toBe(false);
  });

  it("treats two unresolved dates keeping different phrases as the same value", () => {
    const contract = {
      timestamp: null,
      precision: "relative_unresolved",
      phrase: "when the contract lands",
    } as const;
    const funding = {
      timestamp: null,
      precision: "relative_unresolved",
      phrase: "when funding clears",
    } as const;

    expect(isSameValue(contract, funding)).toBe(true);
  });
});
