import { describe, expect, it } from "vitest";
import type { Entity } from "../../src/domain/knowledge/entity.js";
import {
  type CandidateReads,
  generateCandidates,
} from "../../src/inference/resolution/candidate-generation.js";
import { anEntity } from "../support/knowledge-builders.js";

/**
 * Reads returning canned results, so generation is tested for what it does with
 * three sources rather than for what SQLite does with a query. The adapter's
 * own behaviour is pinned in `tests/persistence/entity-repository.test.ts`
 * against the real database.
 */
function readsReturning(results: Partial<CannedResults> = {}): CandidateReads {
  return {
    byExactName: async () => results.exact ?? [],
    byFuzzyName: async () => results.fuzzy ?? [],
    byNearestEmbedding: async () => results.near ?? [],
  };
}

interface CannedResults {
  readonly exact: readonly Entity[];
  readonly fuzzy: readonly Entity[];
  readonly near: readonly { entity: Entity; distance: number }[];
}

const A_MENTION = { mentionText: "Sarah", entityType: "Person" } as const;
const AN_EMBEDDING = Float32Array.from([1, 0, 0]);

describe("candidate generation", () => {
  it("returns nothing when no source finds anything", async () => {
    const candidates = await generateCandidates(A_MENTION, readsReturning());

    expect(candidates).toEqual([]);
  });

  it("returns an entity found by the alias source", async () => {
    const sarah = anEntity();
    const candidates = await generateCandidates(A_MENTION, readsReturning({ exact: [sarah] }));

    expect(candidates).toEqual([{ entity: sarah, sources: ["alias"] }]);
  });

  /**
   * The agreement between independent signals is the cheapest evidence
   * available and the scorer reads it directly, so an entity found by several
   * sources appears once carrying all of them rather than several times.
   */
  it("merges an entity found by several sources into one candidate", async () => {
    const sarah = anEntity();
    const candidates = await generateCandidates(
      { ...A_MENTION, embedding: AN_EMBEDDING },
      readsReturning({
        exact: [sarah],
        fuzzy: [sarah],
        near: [{ entity: sarah, distance: 0.1 }],
      }),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sources).toEqual(["alias", "fuzzy", "vector"]);
  });

  it("keeps the distance from the vector source", async () => {
    const sarah = anEntity();
    const candidates = await generateCandidates(
      { ...A_MENTION, embedding: AN_EMBEDDING },
      readsReturning({ near: [{ entity: sarah, distance: 0.25 }] }),
    );

    expect(candidates[0]?.distance).toBe(0.25);
  });

  it("carries no distance for a candidate no vector search found", async () => {
    const candidates = await generateCandidates(A_MENTION, readsReturning({ exact: [anEntity()] }));

    expect(candidates[0]).not.toHaveProperty("distance");
  });

  it("returns distinct entities as distinct candidates", async () => {
    const first = anEntity({ id: "per-1" });
    const second = anEntity({ id: "per-2" });
    const candidates = await generateCandidates(
      A_MENTION,
      readsReturning({ exact: [first], fuzzy: [second] }),
    );

    expect(candidates.map(({ entity }) => entity.id)).toEqual(["per-1", "per-2"]);
  });

  /**
   * The embedder is a model and a model can be down. Losing the vector source
   * costs recall on paraphrase; failing the whole resolution would cost the
   * common case, which the two name sources handle.
   */
  it("degrades to the name sources when no embedding is available", async () => {
    const sarah = anEntity();
    let wasSearched = false;
    const reads: CandidateReads = {
      ...readsReturning({ exact: [sarah] }),
      byNearestEmbedding: async () => {
        wasSearched = true;
        return [];
      },
    };

    const candidates = await generateCandidates(A_MENTION, reads);

    expect(candidates).toHaveLength(1);
    expect(wasSearched, "no embedding means no vector search").toBe(false);
  });

  it("asks the vector source for a wider set than the adjudicator ever sees", async () => {
    let requestedLimit = 0;
    const reads: CandidateReads = {
      ...readsReturning(),
      byNearestEmbedding: async (query) => {
        requestedLimit = query.limit;
        return [];
      },
    };

    await generateCandidates({ ...A_MENTION, embedding: AN_EMBEDDING }, reads);

    expect(requestedLimit).toBe(20);
  });

  /**
   * Type agreement is enforced here as a **filter**, which is why the scorer
   * has no `typeAgreement` feature — every candidate that reaches it already
   * agrees, so scoring it would score a constant (`scoring.ts`).
   *
   * The consequence is worth pinning: all three sources are asked for one type,
   * so a candidate of another type is never generated. A feature could be
   * outvoted by the other signals; a filter cannot.
   */
  it("asks every source for the Mention's type, so no other type is generated", async () => {
    const asked: string[] = [];
    const reads: CandidateReads = {
      byExactName: async (_name, type) => {
        asked.push(type);
        return [];
      },
      byFuzzyName: async (_name, type) => {
        asked.push(type);
        return [];
      },
      byNearestEmbedding: async (query) => {
        asked.push(query.type);
        return [];
      },
    };

    await generateCandidates({ ...A_MENTION, embedding: AN_EMBEDDING }, reads);

    expect(asked).toEqual(["Person", "Person", "Person"]);
  });

  it("searches for the type the Mention claims", async () => {
    let searchedType = "";
    const reads: CandidateReads = {
      ...readsReturning(),
      byExactName: async (_name, type) => {
        searchedType = type;
        return [];
      },
    };

    await generateCandidates({ mentionText: "Helios", entityType: "Project" }, reads);

    expect(searchedType).toBe("Project");
  });

  it("does not record one source twice for one entity", async () => {
    const sarah = anEntity();
    const candidates = await generateCandidates(
      A_MENTION,
      readsReturning({ exact: [sarah, sarah] }),
    );

    expect(candidates[0]?.sources).toEqual(["alias"]);
  });
});
