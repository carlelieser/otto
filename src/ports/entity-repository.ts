import type { Entity } from "../domain/knowledge/entity.js";
import type { Relation } from "../domain/knowledge/relation.js";
import type { EntityType } from "../domain/schema/entity-schema.js";

/**
 * Projection reads per entity type, **read-only from `inference/`'s
 * perspective** (`add.md` §9).
 *
 * Resolution is the only stage that reads current knowledge (§5.3), and this is
 * what it reads it through. The port has no write method at all, which is the
 * strong form of ADR-0003's rule: `inference/` cannot write because there is
 * nothing on this interface to write with, rather than because a lint rule
 * catches it afterwards. The lint rule in `tests/boundaries/` still forbids
 * `inference/` from importing this port's *name* — the stage receives an
 * implementation rather than reaching for one.
 *
 * One adapter, per §9: SQLite runs in `:memory:`, which is the real adapter
 * with no disk rather than a second implementation of it. Slice 0 built an
 * in-memory `EventStore` whose stored events could be edited in place, which
 * the SQLite adapter refused, and no test noticed because each adapter was only
 * ever compared against itself.
 */
export interface EntityRepository {
  /** The entity with this id, or `undefined` when no entity has it. */
  byId(id: string): Promise<Entity | undefined>;

  /**
   * Entities whose name or an alias matches `name` exactly, case-insensitively.
   *
   * The cheapest of the three candidate sources and the highest-precision:
   * "Sarah Chen" written twice is the same Sarah, and no scoring is needed to
   * say so. Returns every match rather than one, because two people may share a
   * name and that ambiguity is precisely what the scorer exists to resolve.
   */
  byExactName(name: string, type: EntityType): Promise<readonly Entity[]>;

  /**
   * Entities of `type` whose name is within an edit distance of `name`.
   *
   * Catches the transcription errors `runtime.md` §2 names as the metric that
   * matters — a small model hearing "Sarah Chen" as "Sara Chen" — which an
   * exact match misses entirely and which a vector search finds only by
   * accident, since embeddings encode meaning rather than spelling.
   */
  byFuzzyName(name: string, type: EntityType): Promise<readonly Entity[]>;

  /**
   * The `limit` entities of `type` nearest `embedding`, nearest first.
   *
   * The third candidate source, and the one that catches what neither name
   * match can: "the Helios rollout" and "the website relaunch" naming one
   * Project. Required regardless of model quality, because the entity graph
   * does not fit in a context window (`add.md` §5.3).
   */
  byNearestEmbedding(query: EmbeddingQuery): Promise<readonly ScoredEntity[]>;

  /** Every relation with `entityId` at either end. Feeds the co-occurrence feature. */
  relationsOf(entityId: string): Promise<readonly Relation[]>;
}

/** A nearest-neighbour search: the vector, the type to search within, and how many. */
export interface EmbeddingQuery {
  readonly embedding: Float32Array;
  readonly type: EntityType;
  readonly limit: number;
}

/** An entity and how near it was, in whatever metric the index uses. */
export interface ScoredEntity {
  readonly entity: Entity;
  /** Cosine distance, so smaller is nearer. Zero is identical. */
  readonly distance: number;
}

/**
 * A candidate entity and why it was proposed, defined by the stage that
 * produces it.
 *
 * Re-exported here rather than redeclared. `inference/resolution/` owns the
 * shape because generation is what builds it, and this port is what feeds
 * generation — two declarations of one type are two things that can disagree,
 * and the disagreement would be silent since both would typecheck.
 *
 * The direction is the one the layering permits: `ports/` may name a type from
 * `inference/`, and `inference/` may not name this port (`add.md` §3).
 */
export type { Candidate, CandidateSource } from "../inference/resolution/candidate-generation.js";
