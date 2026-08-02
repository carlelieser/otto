import { describe, expect, it } from "vitest";
import type { Candidate } from "../../src/inference/resolution/candidate-generation.js";
import { type ScoringContext, scoreCandidates } from "../../src/inference/resolution/scoring.js";
import { MATCH_FLOOR } from "../../src/inference/resolution/resolve-mention.js";
import { aCandidate, anEntity } from "../support/knowledge-builders.js";

const CAPTURED_AT = "2026-08-01T09:00:00.000Z";

function aContext(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    mentionText: "Sarah Chen",
    entityType: "Person",
    coResolvedIds: [],
    relatedIds: new Map(),
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}

/** A date value as the projection stores one, for the recency feature. */
function contactedAt(timestamp: string) {
  return { timestamp, precision: "day", phrase: "then" } as const;
}

describe("name similarity", () => {
  it("scores an exact name higher than a near one", () => {
    const exact = aCandidate({
      entity: anEntity({ id: "per-1", fields: { name: ["Sarah Chen"] } }),
    });
    const near = aCandidate({ entity: anEntity({ id: "per-2", fields: { name: ["Sara Chan"] } }) });

    const [best] = scoreCandidates([near, exact], aContext());

    expect(best?.candidate.entity.id).toBe("per-1");
  });

  /**
   * An entity recorded as "Sarah Chen" with the alias "Sar" is a perfect match
   * for a note saying "Sar". Scoring only the display name would rank it below
   * an unrelated "Sara".
   */
  it("scores against aliases as well as the display name", () => {
    const aliased = anEntity({ fields: { name: ["Sarah Chen"], aliases: ["Sar"] } });

    const [scored] = scoreCandidates(
      [aCandidate({ entity: aliased })],
      aContext({ mentionText: "Sar" }),
    );

    expect(scored?.features.nameSimilarity).toBe(1);
  });

  it("scores a nameless entity at zero rather than throwing", () => {
    const nameless = aCandidate({ entity: anEntity({ fields: {} }) });

    const [scored] = scoreCandidates([nameless], aContext());

    expect(scored?.features.nameSimilarity).toBe(0);
  });
});

describe("source agreement", () => {
  it("scores a candidate found by all three sources above one found by one", () => {
    const all = aCandidate({
      entity: anEntity({ id: "per-1" }),
      sources: ["alias", "fuzzy", "vector"],
    });
    const one = aCandidate({ entity: anEntity({ id: "per-2" }), sources: ["fuzzy"] });

    const scored = scoreCandidates([all, one], aContext({ mentionText: "Sarah Chen" }));

    expect(scored[0]?.features.sourceAgreement).toBeGreaterThan(
      scored[1]!.features.sourceAgreement,
    );
  });
});

describe("co-occurrence", () => {
  /** A Sarah on the Helios project is the likelier Sarah in a note mentioning Helios. */
  it("favours a candidate related to something else the Capture resolved", () => {
    const connected = aCandidate({
      entity: anEntity({ id: "per-1", fields: { name: ["Sarah"] } }),
    });
    const isolated = aCandidate({ entity: anEntity({ id: "per-2", fields: { name: ["Sarah"] } }) });

    const scored = scoreCandidates(
      [isolated, connected],
      aContext({
        mentionText: "Sarah",
        coResolvedIds: ["proj-helios"],
        relatedIds: new Map([["per-1", ["proj-helios"]]]),
      }),
    );

    expect(scored[0]?.candidate.entity.id).toBe("per-1");
  });

  it("scores zero when the Capture resolved nothing else", () => {
    const [scored] = scoreCandidates(
      [aCandidate()],
      aContext({ relatedIds: new Map([["per-sarah", ["proj-helios"]]]) }),
    );

    expect(scored?.features.coOccurrence).toBe(0);
  });

  it("scores zero for a candidate with no relations", () => {
    const [scored] = scoreCandidates([aCandidate()], aContext({ coResolvedIds: ["proj-helios"] }));

    expect(scored?.features.coOccurrence).toBe(0);
  });
});

describe("recency", () => {
  it("favours a recently contacted entity over a long-silent one", () => {
    const recent = aCandidate({
      entity: anEntity({
        id: "per-1",
        fields: { name: ["Sarah"], last_contact_at: [contactedAt("2026-07-30T00:00:00.000Z")] },
      }),
    });
    const stale = aCandidate({
      entity: anEntity({
        id: "per-2",
        fields: { name: ["Sarah"], last_contact_at: [contactedAt("2026-01-01T00:00:00.000Z")] },
      }),
    });

    const scored = scoreCandidates([stale, recent], aContext({ mentionText: "Sarah" }));

    expect(scored[0]?.candidate.entity.id).toBe("per-1");
  });

  /**
   * Absent is not the same as long ago: a Person created last week has no
   * contact history by construction and should not be penalised for it.
   */
  it("scores an entity with no recorded contact at zero", () => {
    const [scored] = scoreCandidates([aCandidate()], aContext());

    expect(scored?.features.recency).toBe(0);
  });

  it("scores an unresolved contact date at zero rather than NaN", () => {
    const unresolved = aCandidate({
      entity: anEntity({
        fields: {
          name: ["Sarah"],
          last_contact_at: [
            { timestamp: null, precision: "relative_unresolved", phrase: "a while back" },
          ],
        },
      }),
    });

    const [scored] = scoreCandidates([unresolved], aContext());

    expect(scored?.features.recency).toBe(0);
  });

  it("scores a contact date beyond the horizon at zero, not negative", () => {
    const ancient = aCandidate({
      entity: anEntity({
        fields: { name: ["Sarah"], last_contact_at: [contactedAt("2020-01-01T00:00:00.000Z")] },
      }),
    });

    const [scored] = scoreCandidates([ancient], aContext());

    expect(scored?.features.recency).toBe(0);
  });
});

describe("the score itself", () => {
  it("returns candidates best first", () => {
    const best = aCandidate({
      entity: anEntity({ id: "per-1", fields: { name: ["Sarah Chen"] } }),
      sources: ["alias", "fuzzy", "vector"],
    });
    const worst = aCandidate({
      entity: anEntity({ id: "per-2", fields: { name: ["Marco Silva"] } }),
      sources: ["vector"],
    });

    expect(scoreCandidates([worst, best], aContext())[0]?.candidate.entity.id).toBe("per-1");
  });

  it("never leaves the unit interval", () => {
    const perfect = aCandidate({
      entity: anEntity({
        fields: {
          name: ["Sarah Chen"],
          last_contact_at: [contactedAt(CAPTURED_AT)],
        },
      }),
      sources: ["alias", "fuzzy", "vector"],
    });

    const [scored] = scoreCandidates(
      [perfect],
      aContext({ coResolvedIds: ["proj-1"], relatedIds: new Map([["per-sarah", ["proj-1"]]]) }),
    );

    expect(scored!.score).toBeGreaterThanOrEqual(0);
    expect(scored!.score).toBeLessThanOrEqual(1);
  });

  it("scores nothing for no candidates", () => {
    expect(scoreCandidates([] as readonly Candidate[], aContext())).toEqual([]);
  });

  /**
   * The other half of the weighting decision. Name similarity alone can carry a
   * match past the floor, so the corroborating features must not be able to —
   * otherwise "a different person Otto happens to have talked to lately" would
   * resolve, which is exactly the misattribution ADR-0009 biases against.
   */
  it("cannot carry an unrelated name over the match floor on corroboration alone", () => {
    const wrongPerson = aCandidate({
      entity: anEntity({
        fields: {
          name: ["Marco Silva"],
          last_contact_at: [contactedAt(CAPTURED_AT)],
        },
      }),
      sources: ["alias", "fuzzy", "vector"],
    });

    const [scored] = scoreCandidates(
      [wrongPerson],
      aContext({
        mentionText: "Sarah Chen",
        coResolvedIds: ["proj-1"],
        relatedIds: new Map([["per-sarah", ["proj-1"]]]),
      }),
    );

    expect(scored!.score, "every corroborator maxed, name wrong").toBeLessThan(MATCH_FLOOR);
  });

  it("reports the features behind the score, so the number is arguable", () => {
    const [scored] = scoreCandidates([aCandidate()], aContext());

    expect(Object.keys(scored!.features).sort()).toEqual([
      "coOccurrence",
      "nameSimilarity",
      "recency",
      "sourceAgreement",
    ]);
  });
});
