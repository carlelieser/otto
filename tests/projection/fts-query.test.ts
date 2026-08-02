import { describe, expect, it } from "vitest";
import { toMatchQuery } from "../../src/infrastructure/persistence/fts-query.js";

/**
 * FTS5's query language is not a plain string, and everything here is a query a
 * user could plausibly type into a search box. Each case is either an operator
 * they did not mean or a syntax error that would throw.
 */

describe("building an FTS5 match expression", () => {
  it("quotes a single term", () => {
    expect(toMatchQuery("Sarah")).toBe('"Sarah"');
  });

  it("joins terms as a conjunction", () => {
    expect(toMatchQuery("Sarah Chen")).toBe('"Sarah" "Chen"');
  });

  /** `OR` is an FTS5 operator, and a user typing it means the word. */
  it("treats a boolean operator as a literal term", () => {
    expect(toMatchQuery("Sarah OR Globex")).toBe('"Sarah" "OR" "Globex"');
  });

  /** A column filter would search a column the user never named. */
  it("neutralises a column filter", () => {
    expect(toMatchQuery("text:Sarah")).toBe('"text:Sarah"');
  });

  /** An unbalanced quote is a syntax error, which throws rather than returning nothing. */
  it("escapes an embedded quote", () => {
    expect(toMatchQuery('say "hello"')).toBe('"say" """hello"""');
  });

  it("treats a prefix star as a literal", () => {
    expect(toMatchQuery("Sar*")).toBe('"Sar*"');
  });

  it("collapses runs of whitespace", () => {
    expect(toMatchQuery("  Sarah   Chen  ")).toBe('"Sarah" "Chen"');
  });
});

describe("a query with nothing to search for", () => {
  it("returns undefined for an empty query", () => {
    expect(toMatchQuery("")).toBeUndefined();
  });

  it("returns undefined for whitespace", () => {
    expect(toMatchQuery("   ")).toBeUndefined();
  });

  /**
   * A token of pure punctuation matches nothing under `unicode61`, and quoting
   * it produces `""`, which FTS5 rejects outright.
   */
  it("drops a token with no searchable character", () => {
    expect(toMatchQuery("Sarah ?")).toBe('"Sarah"');
  });

  it("returns undefined when every token is punctuation", () => {
    expect(toMatchQuery("? -- !")).toBeUndefined();
  });

  it("keeps a term with digits", () => {
    expect(toMatchQuery("Q3")).toBe('"Q3"');
  });

  /** Non-ASCII letters are searchable, and a name is where they appear. */
  it("keeps a non-ASCII term", () => {
    expect(toMatchQuery("Siobhán")).toBe('"Siobhán"');
  });
});
