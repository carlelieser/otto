/**
 * Whitespace and transcript cleanup, and nothing else (`add.md` §5.1).
 *
 * Ingestion carries no semantic reasoning: it transcribes, cleans up,
 * timestamps, and deduplicates. `add.md` §5.1 uses date-noticing as the
 * specific example of what it must not do, and the temptation is constant —
 * moving that work earlier turns a normaliser into a second, undisciplined
 * extractor.
 *
 * So the brief is closed rather than open. There are exactly three rules, in
 * this order, and the test that pins them asserts their *limits* as much as
 * their effects. Punctuation repair, capitalisation, and filler-word removal
 * are all excluded, because each requires deciding what the user meant.
 *
 * This does not feed `content_hash`, which covers the raw text. That is what
 * makes the list safe to extend: adding a rule changes what downstream reads
 * without re-keying a single existing Capture.
 */

/** Every run of Unicode whitespace, which a paste can contribute more of than ASCII has. */
const WHITESPACE_RUN = /\s+/gu;

/** What a collapsed run becomes: one ordinary space. */
const SINGLE_SPACE = " ";

/**
 * The text downstream reads, derived from the raw text on every read.
 *
 * Not stored. `runtime.md` §5 keeps normalised text out of the database because
 * a stored copy is a second truth that can disagree with the first the day a
 * rule here changes.
 *
 * NFC runs first so the two whitespace steps see composed characters. Newlines
 * collapse along with everything else: a Capture is one thought, not a
 * document, and keeping line structure would preserve a formatting decision the
 * capture window does not offer.
 */
export function normalise(rawText: string): string {
  return rawText.normalize("NFC").replace(WHITESPACE_RUN, SINGLE_SPACE).trim();
}
