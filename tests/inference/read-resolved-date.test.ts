import { describe, expect, it } from "vitest";
import {
  isTimeOrdered,
  resolvedDateViolations,
  type ResolvedDate,
} from "../../src/domain/values/resolved-date.js";
import { readResolvedDate } from "../../src/inference/extraction/read-resolved-date.js";

/**
 * `schema.md` §8's two halves: dates come back absolute, and the precision
 * marker survives.
 *
 * The model does the resolving — these are tests of what the parser accepts
 * back, which is the part that is deterministic and therefore assertable
 * (`qa.md` §2). Whether the model resolves "Tuesday" to the right Tuesday is an
 * eval-set question and is measured rather than asserted.
 */

describe("reading a resolved date", () => {
  it.each(["exact", "day", "month", "quarter", "year"])(
    "keeps a %s-precision date and its timestamp",
    (precision) => {
      const date = readResolvedDate({
        value: "2026-08-04T00:00:00.000Z",
        date_precision: precision,
        phrase: "next Tuesday",
      });

      expect(date).toEqual({
        timestamp: "2026-08-04T00:00:00.000Z",
        precision,
        phrase: "next Tuesday",
      });
    },
  );

  /**
   * The distinction §8 exists to preserve: "sometime next quarter" and "on the
   * 4th" must not become indistinguishable timestamps. Both carry an instant;
   * only the marker tells them apart, and it is what the UI renders from.
   */
  it("distinguishes a quarter from a day at the same instant", () => {
    const instant = "2026-07-01T00:00:00.000Z";
    const quarter = readResolvedDate({
      value: instant,
      date_precision: "quarter",
      phrase: "next quarter",
    });
    const day = readResolvedDate({ value: instant, date_precision: "day", phrase: "on the 1st" });

    expect(quarter!.timestamp).toEqual(day!.timestamp);
    expect(quarter!.precision).not.toEqual(day!.precision);
  });

  describe("relative_unresolved", () => {
    /**
     * The honest failure case: "when the contract lands" is a real thing a note
     * says and is not a date. It stores no timestamp, keeps the phrase, and is
     * excluded from anything time-ordered.
     */
    it("stores no timestamp and keeps the phrase", () => {
      const date = readResolvedDate({
        date_precision: "relative_unresolved",
        phrase: "when the contract lands",
      });

      expect(date).toEqual({
        timestamp: null,
        precision: "relative_unresolved",
        phrase: "when the contract lands",
      });
    });

    it("is excluded from anything time-ordered", () => {
      const date = readResolvedDate({
        date_precision: "relative_unresolved",
        phrase: "when the contract lands",
      })!;

      expect(isTimeOrdered(date)).toBe(false);
    });

    /**
     * A grammar constrains shape, not the relationship between two fields, so a
     * model can emit `relative_unresolved` beside a timestamp. The timestamp is
     * the invented half — the phrase is what the note actually said — so the
     * looser reading wins.
     */
    it("discards a timestamp emitted beside it", () => {
      const date = readResolvedDate({
        value: "2026-09-01T00:00:00.000Z",
        date_precision: "relative_unresolved",
        phrase: "when the contract lands",
      });

      expect(date!.timestamp).toBeNull();
    });

    /** The mirror case: a precision claiming resolution with nothing resolved. */
    it("is what a resolved precision with no timestamp degrades to", () => {
      const date = readResolvedDate({ date_precision: "day", phrase: "Tuesday" });

      expect(date).toEqual({
        timestamp: null,
        precision: "relative_unresolved",
        phrase: "Tuesday",
      });
    });
  });

  describe("normalising the instant", () => {
    /**
     * One instant formatted two ways compares as two instants, and a model
     * asked for a date returns all three of these forms across runs of the same
     * note. Normalising here keeps the eval set's date-accuracy metric from
     * measuring formatting.
     */
    it.each([
      ["a bare date", "2026-08-04"],
      ["seconds precision", "2026-08-04T00:00:00Z"],
      ["milliseconds", "2026-08-04T00:00:00.000Z"],
    ])("reads %s as the same UTC instant", (_case, value) => {
      const date = readResolvedDate({ value, date_precision: "day", phrase: "the 4th" });

      expect(date!.timestamp).toBe("2026-08-04T00:00:00.000Z");
    });
  });

  describe("what is dropped", () => {
    it("drops a date with no phrase, since the phrase is unreconstructable", () => {
      expect(readResolvedDate({ value: "2026-08-04", date_precision: "day" })).toBeNull();
    });

    it("drops a precision outside the six", () => {
      expect(
        readResolvedDate({ value: "2026-08-04", date_precision: "fortnight", phrase: "soon" }),
      ).toBeNull();
    });

    it.each([
      ["a non-object", 42],
      ["null", null],
      ["an empty object", {}],
    ])("drops %s rather than throwing", (_case, raw) => {
      expect(readResolvedDate(raw)).toBeNull();
    });

    it("degrades an unparseable timestamp to unresolved rather than dropping the phrase", () => {
      const date = readResolvedDate({
        value: "next Tuesday",
        date_precision: "day",
        phrase: "next Tuesday",
      });

      expect(date).toEqual({
        timestamp: null,
        precision: "relative_unresolved",
        phrase: "next Tuesday",
      });
    });
  });

  /**
   * Everything this parser emits is well-formed by the domain's own rule. The
   * two checks are independent — one validates input, the other states the
   * invariant — and this is what ties them together.
   */
  it("emits only well-formed resolved dates", () => {
    const inputs: unknown[] = [
      { value: "2026-08-04", date_precision: "day", phrase: "the 4th" },
      { value: "bad", date_precision: "exact", phrase: "then" },
      { date_precision: "relative_unresolved", phrase: "when it lands" },
      { value: "2026-08-04", date_precision: "relative_unresolved", phrase: "when it lands" },
    ];

    const dates = inputs
      .map((raw) => readResolvedDate(raw))
      .filter((date): date is ResolvedDate => date !== null);

    expect(dates).toHaveLength(inputs.length);
    for (const date of dates) expect(resolvedDateViolations(date)).toEqual([]);
  });
});
