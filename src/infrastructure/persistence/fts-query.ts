/**
 * A user's search text as an FTS5 `MATCH` expression, or `undefined` when there
 * is nothing to search for.
 *
 * **FTS5's query language is not a plain string.** Bare user input reaches
 * `MATCH` as syntax: `AND`, `OR`, `NOT` and `NEAR` are operators, `*` is a
 * prefix, `:` is a column filter, `^` anchors, and an unbalanced quote is a
 * syntax error that throws rather than returning nothing. A user searching for
 * `Q3: OKRs` would get an error, and one searching `Sarah OR Globex` would get
 * results they did not ask for.
 *
 * So every token is wrapped in double quotes, which makes it a literal string
 * in FTS5's grammar, and any embedded quote is doubled — the one escape the
 * grammar has. What reaches the index is a conjunction of literal terms, which
 * is what a search box means by a query.
 *
 * A phrase search, a prefix, or boolean operators would each be a deliberate
 * feature with its own syntax on the way in. None of them is in this slice, and
 * getting them by accident is the failure this function prevents.
 */
export function toMatchQuery(query: string): string | undefined {
  const tokens = query.split(/\s+/u).filter((token) => hasSearchableCharacter(token));
  if (tokens.length === 0) return undefined;
  return tokens.map(quoteToken).join(" ");
}

/**
 * Whether a token holds anything the index could match.
 *
 * `unicode61` tokenises on letters, digits, and marks, so a token of pure
 * punctuation matches nothing — and quoting it produces `""`, which FTS5
 * rejects as a syntax error. Dropping it is the difference between a search for
 * `Sarah ?` returning Sarah and it throwing.
 */
function hasSearchableCharacter(token: string): boolean {
  return /[\p{L}\p{N}\p{M}]/u.test(token);
}

/** One token as an FTS5 string literal, with embedded quotes doubled. */
function quoteToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}
