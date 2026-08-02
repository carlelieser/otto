import { RELATION_NAMES, type RelationName } from "../../domain/schema/relation-schema.js";

/**
 * `relates_to`'s share of the graph, reported rather than asserted.
 *
 * `schema.md` §6 calls `relates_to` the deliberate catch-all and the one to
 * watch: if it dominates, the vocabulary is too small and needs a named
 * addition. `qa.md` §7.3 is explicit that this is **monitoring, not
 * assertion** — a failing test here would be a test that fails as the knowledge
 * base grows, which teaches everyone to delete it.
 *
 * So this computes a number and says nothing about whether the number is
 * acceptable. The judgement is the maintainer's, made against a report, which
 * is the same arrangement `notes` growth uses as the schema's health metric
 * (§7).
 *
 * It lives in `inference/` because it is Otto's judgement about its own
 * contents rather than a fact about the user's knowledge — the test ADR-0002
 * applies, and "is my relation vocabulary too small" stops being a question
 * anyone asks the moment Otto is deleted.
 */

/** How often each relation name appears in the graph, and what share is `relates_to`. */
export interface RelationMix {
  readonly counts: Readonly<Record<RelationName, number>>;
  readonly total: number;
  /** `relates_to` as a fraction of all edges, in [0, 1]. Zero on an empty graph. */
  readonly catchAllShare: number;
}

/** The relation §6 names as the catch-all whose dominance is the signal. */
export const CATCH_ALL_RELATION: RelationName = "relates_to";

/** The mix of relation names across `names`, with the catch-all's share of it. */
export function relationMix(names: readonly RelationName[]): RelationMix {
  const counts = countByName(names);
  const total = names.length;
  return {
    counts,
    total,
    catchAllShare: total === 0 ? 0 : counts[CATCH_ALL_RELATION] / total,
  };
}

/**
 * Every name counted, including the ones that never appear.
 *
 * A relation absent from the graph reports zero rather than being missing from
 * the record, because the report is read as a table and a missing row reads as
 * an oversight rather than as an absence.
 */
function countByName(names: readonly RelationName[]): Record<RelationName, number> {
  const counts = Object.fromEntries(RELATION_NAMES.map((name) => [name, 0])) as Record<
    RelationName,
    number
  >;
  for (const name of names) counts[name] += 1;
  return counts;
}
