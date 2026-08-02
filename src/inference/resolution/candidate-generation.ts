import type { Entity } from "../../domain/knowledge/entity.js";
import type { EntityType } from "../../domain/schema/entity-schema.js";

/**
 * Narrowing thousands of entities to a handful, deterministically and cheaply
 * (`add.md` §5.3).
 *
 * Required regardless of how good the model is, because the entity graph does
 * not fit in a context window. Three sources, each catching what the others
 * miss:
 *
 * - **alias** — exact hits on a name or a recorded alias. Cheapest and highest
 *   precision: "Sarah Chen" written twice is the same Sarah.
 * - **fuzzy** — near-miss names. Catches the transcription error `runtime.md`
 *   §2 names as the metric that matters, which exact matching misses entirely.
 * - **vector** — embedding nearest-neighbours. Catches what neither name match
 *   can: "the Helios rollout" and "the website relaunch" naming one Project.
 *
 * Generation deliberately does not discriminate. Its job is recall — the scorer
 * is what discriminates, and a candidate wrongly excluded here can never be
 * recovered, while a candidate wrongly included costs one comparison.
 *
 * ## Why the reads arrive as a parameter
 *
 * `add.md` §3's first rule: nothing under `inference/` imports a repository
 * port. Resolution is the only stage that reads current knowledge and it still
 * may not reach for a store — it is *given* the reads, by `application/`, which
 * is what keeps ADR-0003's "inference cannot write" from depending on everyone
 * remembering that the port has no write method.
 */

/** The reads candidate generation needs, supplied by the composition root. */
export interface CandidateReads {
  byExactName(name: string, type: EntityType): Promise<readonly Entity[]>;
  byFuzzyName(name: string, type: EntityType): Promise<readonly Entity[]>;
  byNearestEmbedding(query: NearestQuery): Promise<readonly NearEntity[]>;
}

export interface NearestQuery {
  readonly embedding: Float32Array;
  readonly type: EntityType;
  readonly limit: number;
}

export interface NearEntity {
  readonly entity: Entity;
  readonly distance: number;
}

/** Why an entity was proposed, mirroring `ports/entity-repository.ts`. */
export type CandidateSource = "alias" | "fuzzy" | "vector";

/** An entity that might be what a Mention refers to, and how it was found. */
export interface Candidate {
  readonly entity: Entity;
  readonly sources: readonly CandidateSource[];
  readonly distance?: number;
}

/** A Mention to find candidates for, and optionally its embedding. */
export interface CandidateRequest {
  readonly mentionText: string;
  readonly entityType: EntityType;
  /**
   * The Mention's embedding, when one could be computed.
   *
   * Optional because the embedder is a model and a model can be down. Missing
   * it degrades generation to the two name sources rather than failing the
   * whole resolution — which is the right trade, since the name sources are the
   * high-precision ones and losing the vector source costs recall on paraphrase
   * rather than correctness on the common case.
   */
  readonly embedding?: Float32Array;
}

/**
 * How many vector neighbours to pull before scoring.
 *
 * Wider than the three or four the adjudicator ever sees, because this is the
 * recall stage and the scorer narrows afterwards. Twenty is the top-k the
 * standing performance bar is stated over (`qa.md` §8), so widening it is a
 * change that has to be re-measured rather than a constant to tune freely.
 */
const VECTOR_NEIGHBOURS = 20;

/**
 * Every candidate for `request`, merged across the three sources.
 *
 * An entity found by several sources appears once carrying all of them: that
 * agreement between independent signals is the cheapest evidence available and
 * the scorer reads it directly. Collapsing to a boolean would throw it away.
 */
export async function generateCandidates(
  request: CandidateRequest,
  reads: CandidateReads,
): Promise<readonly Candidate[]> {
  const { mentionText, entityType } = request;
  const [exact, fuzzy, near] = await Promise.all([
    reads.byExactName(mentionText, entityType),
    reads.byFuzzyName(mentionText, entityType),
    nearestOf(request, reads),
  ]);

  const merged = new Map<string, MutableCandidate>();
  addAll(merged, exact, "alias");
  addAll(merged, fuzzy, "fuzzy");
  addNear(merged, near);
  return [...merged.values()].map(toCandidate);
}

/** The vector source's hits, or none when no embedding could be computed. */
async function nearestOf(
  request: CandidateRequest,
  reads: CandidateReads,
): Promise<readonly NearEntity[]> {
  const { embedding, entityType } = request;
  if (embedding === undefined) return [];
  return reads.byNearestEmbedding({ embedding, type: entityType, limit: VECTOR_NEIGHBOURS });
}

interface MutableCandidate {
  readonly entity: Entity;
  readonly sources: CandidateSource[];
  distance?: number;
}

function addAll(
  merged: Map<string, MutableCandidate>,
  entities: readonly Entity[],
  source: CandidateSource,
): void {
  for (const entity of entities) {
    recordSource(merged, entity, source);
  }
}

function addNear(merged: Map<string, MutableCandidate>, near: readonly NearEntity[]): void {
  for (const { entity, distance } of near) {
    recordSource(merged, entity, "vector").distance = distance;
  }
}

function recordSource(
  merged: Map<string, MutableCandidate>,
  entity: Entity,
  source: CandidateSource,
): MutableCandidate {
  const existing = merged.get(entity.id) ?? { entity, sources: [] };
  if (!existing.sources.includes(source)) existing.sources.push(source);
  merged.set(entity.id, existing);
  return existing;
}

function toCandidate(candidate: MutableCandidate): Candidate {
  const { entity, sources, distance } = candidate;
  return { entity, sources, ...(distance === undefined ? {} : { distance }) };
}
