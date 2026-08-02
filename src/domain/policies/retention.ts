/**
 * How long the record of what Otto declined to act on is kept
 * (`triage.md` §7, ADR-0014).
 *
 * Thirty days is a judgement about the user's relationship with their own
 * knowledge rather than about Otto's machinery: long enough that "why didn't
 * Otto pick that up?" about last week's note has an answer, short enough that
 * the collapsed section does not become an archive nobody asked for. It sits
 * with the rules about knowledge for the same reason the application policy
 * does — it would still be a sensible question if a human, rather than a
 * threshold, had done the dropping.
 *
 * The user never has to look. But the answer exists, and the low threshold has
 * an audit trail, which is what makes a band that turns out to be too
 * aggressive recoverable rather than merely regrettable.
 */
export const DISCARD_RETENTION_DAYS = 30;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The instant a discard decided at `decidedAt` stops being shown.
 *
 * Returned as an instant rather than compared in place so the caller — a SQL
 * `WHERE` clause, in practice — can do the comparison in one place with one
 * definition of the boundary behind it.
 */
export function discardExpiryOf(decidedAt: string): string {
  return new Date(
    Date.parse(decidedAt) + DISCARD_RETENTION_DAYS * MILLISECONDS_PER_DAY,
  ).toISOString();
}
