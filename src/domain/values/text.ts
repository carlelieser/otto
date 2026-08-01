/**
 * Whether a value is text with something in it.
 *
 * Shared by the well-formedness checks on events and provenance, which both
 * treat a blank identifier as absent rather than present-but-empty: a
 * whitespace-only Capture id is a missing one, and `qa.md` §4.4 makes that a
 * Tier 0 failure either way.
 */
export function isNonEmptyText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
