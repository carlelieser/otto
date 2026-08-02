import { valuesOf, type Entity } from "../../domain/knowledge/entity.js";
import type { EntityType } from "../../domain/schema/entity-schema.js";
import { nameSimilarity, normaliseName } from "../resolution/name-similarity.js";

/**
 * **Duplicate detection is candidate generation pointed at the entity table**
 * (`triage.md` §5, ADR-0012).
 *
 * Resolution is biased toward "none of these" (ADR-0009), which produces
 * duplicates by design: a duplicate is visible and fixable, and a misattribution
 * quietly corrupts what the user knows. That trade is only honest if the fix
 * exists, and this is the half that finds the pairs to fix.
 *
 * It reuses `nameSimilarity` rather than defining a second notion of alike. The
 * failure it exists to catch is the same one — a small transcription model
 * hearing "Sarah Chen" as "Sara Chen" — arriving as two entities rather than as
 * a Mention that failed to resolve.
 *
 * ## What it does not do
 *
 * It proposes nothing and merges nothing. It returns pairs, and **the user is
 * what turns a pair into a merge** — the application policy's `merge` row is
 * `needs_review` at any confidence (`triage.md` §3), which is a rule about a
 * kind of change rather than a threshold this file could clear.
 *
 * The vector source that candidate generation's third leg uses is deliberately
 * absent. Nearest-neighbour over every pair of entities is quadratic in
 * embeddings rather than in names, and the two name sources are the
 * high-precision ones — losing the third costs recall on a paraphrase, which for
 * duplicates means the pair surfaces the next time either entity is renamed
 * rather than never.
 */

/**
 * How alike two entities must be to be worth the user's glance.
 *
 * Tighter than candidate generation's 0.7 floor, and for the opposite reason.
 * That floor feeds a scorer that discriminates afterwards, so a loose one costs
 * one comparison. This feeds the review queue directly, so a loose floor costs
 * the user an entry — and a queue with false duplicates in it is one they stop
 * reading, which is the failure PRD §8 names as fatal to trust.
 */
export const DUPLICATE_FLOOR = 0.85;

/** Two entities that may always have been one, and how alike they are. */
export interface SuspectedDuplicate {
  /** The identity that survives: the older of the two, so the pair is stable. */
  readonly survivorId: string;
  /** The identity that would become a redirect. */
  readonly mergedId: string;
  /** How alike the pair is, in [0, 1]. The queue orders on it. */
  readonly similarity: number;
  /** What kind of thing the pair is, which both sides share by construction. */
  readonly entityType: EntityType;
}

/**
 * Every pair in `entities` alike enough to be one thing, each reported once.
 *
 * Quadratic in the number of entities of one type, which is the honest shape for
 * "compare everything to everything" and is arithmetic at the 3,000 entities
 * `runtime.md` sizes Otto for — the same argument the fuzzy candidate source
 * makes for scanning in process rather than reaching for an index.
 */
export function suspectedDuplicates(entities: readonly Entity[]): readonly SuspectedDuplicate[] {
  const pairs: SuspectedDuplicate[] = [];
  for (let left = 0; left < entities.length; left += 1) {
    for (let right = left + 1; right < entities.length; right += 1) {
      const pair = pairOf(entities[left]!, entities[right]!);
      if (pair !== undefined) pairs.push(pair);
    }
  }
  return pairs.sort((first, second) => second.similarity - first.similarity);
}

/** The pair these two make, or `undefined` when they are not alike enough. */
function pairOf(left: Entity, right: Entity): SuspectedDuplicate | undefined {
  if (left.type !== right.type) return undefined;
  const similarity = likeness(left, right);
  if (similarity < DUPLICATE_FLOOR) return undefined;
  return { ...direction(left, right), similarity, entityType: left.type };
}

/**
 * How alike two entities are: the best match across every name either goes by.
 *
 * Aliases are included because `schema.md` §2 has them feeding candidate
 * generation directly, and the entity that has accumulated an alias is exactly
 * the one a second record of the same person would have been created under a
 * variant of. The best rather than the average, since one shared alias is
 * evidence and the other five names not matching is not counter-evidence.
 */
function likeness(left: Entity, right: Entity): number {
  const theirs = namesOf(right);
  return Math.max(
    ...namesOf(left).flatMap((name) => theirs.map((other) => nameSimilarity(name, other))),
    0,
  );
}

/** Every name an entity goes by: its own, and each alias. */
function namesOf(entity: Entity): readonly string[] {
  return [...valuesOf(entity, "name"), ...valuesOf(entity, "aliases")]
    .filter((value): value is string => typeof value === "string")
    .map(normaliseName)
    .filter((name) => name !== "");
}

/**
 * Which identity survives: the lower id, compared as a string.
 *
 * **Stable rather than meaningful.** Any rule would do so long as it gives the
 * same answer every time the pair is detected, because an unstable one turns one
 * duplicate into two queue entries pointing opposite ways — the user answers one
 * and the other stays, proposing to undo it.
 *
 * The user is not bound by it. They are confirming that two entities are one,
 * and correcting the entry with the opposite merge is one action from the queue
 * like any other correction.
 */
function direction(left: Entity, right: Entity): { survivorId: string; mergedId: string } {
  const [survivorId, mergedId] = left.id < right.id ? [left.id, right.id] : [right.id, left.id];
  return { survivorId: survivorId!, mergedId: mergedId! };
}
