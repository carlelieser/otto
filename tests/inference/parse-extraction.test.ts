import { describe, expect, it } from "vitest";
import { parseExtraction } from "../../src/inference/extraction/parse-extraction.js";

/**
 * The deterministic half of extraction (`qa.md` §2 rules out asserting an exact
 * extraction *string*; what the parser does with output it is handed is exactly
 * assertable).
 *
 * Every case here is one the slice's Verification section names.
 */

function parse(raw: unknown) {
  return parseExtraction(raw);
}

/** One well-formed mention, for tests that vary a single thing about it. */
function aRawMention(overrides: Record<string, unknown> = {}) {
  return {
    text: "Sarah",
    entity_type: "Person",
    confidence: 0.9,
    fields: [{ field: "employer", value: "Globex" }],
    ...overrides,
  };
}

describe("parsing an extraction", () => {
  it("keeps a field the schema declares", () => {
    const { mentions } = parse({ mentions: [aRawMention()] });

    expect(mentions[0]!.fields).toEqual([{ field: "employer", value: "Globex" }]);
  });

  /**
   * `qa.md` §7.2 and the slice's Verification both ask for this, and both note
   * it *should* be structurally impossible because the output schema is
   * generated from `schema.md`. That is a claim about the grammar, and the
   * grammar only binds the local path — so the parser enforces it too, and this
   * is the test that it does.
   */
  it("rejects an unknown field name rather than passing it on", () => {
    const raw = { mentions: [aRawMention({ fields: [{ field: "shoe_size", value: "44" }] })] };

    const { mentions, violations } = parse(raw);

    expect(mentions[0]!.fields).toEqual([]);
    expect(violations).toEqual([
      { reason: "unknown_field", field: "shoe_size", entityType: "Person" },
    ]);
  });

  it("rejects a field belonging to a different entity type", () => {
    // `employer` is a Person field; a Project has no such field.
    const raw = {
      mentions: [
        aRawMention({ entity_type: "Project", fields: [{ field: "employer", value: "Globex" }] }),
      ],
    };

    const { violations } = parse(raw);

    expect(violations).toEqual([
      { reason: "unknown_field", field: "employer", entityType: "Project" },
    ]);
  });

  describe("derived fields", () => {
    /**
     * `schema.md` §1 and `qa.md` §7.2 require **both halves** tested: the drop,
     * and that the drop is logged as a schema violation rather than accepted
     * quietly. A derived field silently absent from the output would pass a
     * test asserting only the first half.
     */
    it.each(["salience", "last_contact_at"])("drops %s and logs the drop", (field) => {
      const raw = { mentions: [aRawMention({ fields: [{ field, value: "0.9" }] })] };

      const { mentions, violations } = parse(raw);

      expect(mentions[0]!.fields, "the drop").toEqual([]);
      expect(violations, "the log").toEqual([
        { reason: "derived_field", field, entityType: "Person" },
      ]);
    });

    it("distinguishes a derived field from an invented one", () => {
      const raw = {
        mentions: [
          aRawMention({
            fields: [
              { field: "salience", value: "0.9" },
              { field: "shoe_size", value: "44" },
            ],
          }),
        ],
      };

      expect(parse(raw).violations.map(({ reason }) => reason)).toEqual([
        "derived_field",
        "unknown_field",
      ]);
    });
  });

  describe("closed enums", () => {
    it("keeps a value inside the closed set", () => {
      const raw = {
        mentions: [aRawMention({ fields: [{ field: "relationship", value: "colleague" }] })],
      };

      expect(parse(raw).mentions[0]!.fields).toEqual([
        { field: "relationship", value: "colleague" },
      ]);
    });

    /**
     * `schema.md` §7: a value outside the set becomes `other` plus a `notes`
     * entry. That keeps the differ's typing intact while making the pressure
     * visible — a run of `other` values is the signal the enum needs a new
     * member, and it arrives as data rather than as a bug report.
     */
    it("turns a value outside the set into `other` plus a notes entry", () => {
      const raw = {
        mentions: [aRawMention({ fields: [{ field: "relationship", value: "mentor" }] })],
      };

      expect(parse(raw).mentions[0]!.fields).toEqual([
        { field: "relationship", value: "other" },
        { field: "notes", value: "relationship: mentor" },
      ]);
    });

    /**
     * An out-of-set enum is not a schema violation. The escape hatch is the
     * schema working as designed, and counting it against the zero-tolerance
     * violation rate (`qa.md` §6.1) would make that metric unreadable.
     */
    it("does not count the escape hatch as a schema violation", () => {
      const raw = {
        mentions: [aRawMention({ fields: [{ field: "relationship", value: "mentor" }] })],
      };

      expect(parse(raw).violations).toEqual([]);
    });

    it("leaves an explicit `other` alone rather than adding an empty note", () => {
      const raw = {
        mentions: [aRawMention({ fields: [{ field: "relationship", value: "other" }] })],
      };

      expect(parse(raw).mentions[0]!.fields).toEqual([{ field: "relationship", value: "other" }]);
    });
  });

  describe("entity types", () => {
    it("drops a mention whose entity type is not one of the five", () => {
      const raw = { mentions: [aRawMention({ entity_type: "Company" })] };

      const { mentions, violations } = parse(raw);

      expect(mentions).toEqual([]);
      expect(violations).toEqual([
        { reason: "unknown_entity_type", field: "", entityType: "Company" },
      ]);
    });
  });

  describe("notes with nothing in them", () => {
    /**
     * A valid outcome, and one the slice names explicitly: a note containing no
     * extractable entity must produce no spurious Proposal (`qa.md` §6.2). The
     * temptation is to treat empty output as a parse failure.
     */
    it("returns no mentions rather than failing", () => {
      expect(parse({ mentions: [] })).toEqual({ mentions: [], violations: [] });
    });

    it("drops a mention with no text to name it", () => {
      expect(parse({ mentions: [aRawMention({ text: "   " })] }).mentions).toEqual([]);
    });

    /**
     * A nameless mention breaks no schema rule — the model emitted a well-formed
     * Person with no name in it, which is an empty answer rather than an invalid
     * one. Counting it would make the zero-tolerance violation rate measure model
     * verbosity instead of schema compliance (`qa.md` §6.1); mention recall is
     * where a missed entity belongs.
     */
    it("does not count a nameless mention as a schema violation", () => {
      expect(parse({ mentions: [aRawMention({ text: "   " })] }).violations).toEqual([]);
    });
  });

  describe("malformed output", () => {
    /**
     * Grammar-constrained decoding guarantees parseable output, not correct
     * output — and the cloud adapters are not grammar-constrained at all. A
     * parser that assumed shape would throw a `TypeError` from somewhere deep
     * instead of the pipeline recording that extraction failed.
     */
    it.each([
      ["a non-object", 42],
      ["null", null],
      ["a missing mentions array", {}],
      ["mentions that is not an array", { mentions: "Sarah" }],
    ])("throws on %s", (_case, raw) => {
      expect(() => parse(raw)).toThrow(/extraction output/i);
    });

    it("drops a malformed mention without discarding its well-formed siblings", () => {
      const raw = { mentions: [aRawMention(), 42, aRawMention({ text: "Helios" })] };

      expect(parse(raw).mentions.map(({ text }) => text)).toEqual(["Sarah", "Helios"]);
    });
  });

  describe("confidence", () => {
    it("carries the model's self-reported p(extraction)", () => {
      expect(parse({ mentions: [aRawMention({ confidence: 0.42 })] }).mentions[0]!.confidence).toBe(
        0.42,
      );
    });

    it.each([
      ["above 1", 1.5],
      ["below 0", -0.2],
      ["not a number", "high"],
    ])("clamps a confidence %s into [0, 1]", (_case, confidence) => {
      const value = parse({ mentions: [aRawMention({ confidence })] }).mentions[0]!.confidence;

      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    });
  });
});
