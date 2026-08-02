import { describe, expect, it } from "vitest";
import { CORPUS_CATEGORIES } from "./corpus/case.js";
import { EVAL_CORPUS } from "./corpus/notes.js";

/**
 * The corpus is an instrument, so it is checked like one.
 *
 * These are not extraction tests — nothing here runs a model. They pin the
 * properties that make the corpus's numbers mean something: that it covers the
 * cases `qa.md` §6.2 names, that it is large enough for ADR-0006's regression
 * suite, and that no case is silently unscoreable.
 */

/** ADR-0006's minimum for a regression suite. */
const MINIMUM_CASES = 50;

describe("the eval corpus", () => {
  it("has at least ADR-0006's minimum of cases", () => {
    expect(EVAL_CORPUS.length).toBeGreaterThanOrEqual(MINIMUM_CASES);
  });

  /**
   * The check that distinguishes a corpus from a pile of notes. 50 cases all
   * exercising the unambiguous-create path would satisfy the count and measure
   * one thing, and a count alone cannot tell the difference.
   */
  it("covers every case category `qa.md` §6.2 names", () => {
    const covered = new Set(EVAL_CORPUS.map(({ covers }) => covers));

    expect([...CORPUS_CATEGORIES].filter((category) => !covered.has(category))).toEqual([]);
  });

  it("gives every case a unique id", () => {
    const ids = EVAL_CORPUS.map(({ id }) => id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every case a capture timestamp for relative dates to resolve against", () => {
    for (const { id, capturedAt } of EVAL_CORPUS) {
      expect(Number.isNaN(Date.parse(capturedAt)), `${id} has a parseable timestamp`).toBe(false);
    }
  });

  /**
   * A note whose expectations name a date must say what precision it expects,
   * or the `date_precision` metric silently scores nothing. `qa.md` §6.1 lists
   * it as its own metric precisely because it is the one that degrades
   * invisibly.
   */
  it("states a precision for every expected date", () => {
    const dateFields = EVAL_CORPUS.flatMap(({ id, expected }) =>
      expected.flatMap((mention) =>
        (mention.fields ?? [])
          .filter((field) => field.timestamp !== undefined)
          .map((field) => ({ id, field })),
      ),
    );

    expect(dateFields.length).toBeGreaterThan(0);
    for (const { id, field } of dateFields) {
      expect(field.precision, `${id} states a precision for ${field.field}`).toBeDefined();
    }
  });

  /**
   * `relative_unresolved` stores no timestamp (`schema.md` §8). A corpus case
   * expecting both would be asserting something the domain forbids, and would
   * fail every model forever for the wrong reason.
   */
  it("expects no timestamp alongside `relative_unresolved`", () => {
    for (const { id, expected } of EVAL_CORPUS) {
      for (const field of expected.flatMap((mention) => mention.fields ?? [])) {
        if (field.precision !== "relative_unresolved") continue;
        expect(field.timestamp, `${id} expects no instant for an unresolved date`).toBeNull();
      }
    }
  });

  /**
   * The precision cases are the ones most likely to be written wrong, since
   * they are the ones where the expected value is computed rather than read off
   * the note. This pins that every stated instant is a real one.
   */
  it("expects parseable instants", () => {
    for (const { id, expected } of EVAL_CORPUS) {
      for (const field of expected.flatMap((mention) => mention.fields ?? [])) {
        if (typeof field.timestamp !== "string") continue;
        expect(Number.isNaN(Date.parse(field.timestamp)), `${id}: ${field.timestamp}`).toBe(false);
      }
    }
  });

  /**
   * `qa.md` §6.2 asks for notes containing no extractable entity, and they only
   * measure precision if the corpus actually contains some. A corpus where
   * every case expects something cannot catch a model that invents.
   */
  it("contains notes that expect nothing", () => {
    const empty = EVAL_CORPUS.filter(({ expected }) => expected.length === 0);

    expect(empty.length).toBeGreaterThanOrEqual(4);
  });
});
