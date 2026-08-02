import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  AMBIGUITY_MARGIN,
  MATCH_FLOOR,
  PLAUSIBILITY_FLOOR,
  resolveFromScores,
} from "../../src/inference/resolution/resolve-mention.js";
import type { ScoredCandidate } from "../../src/inference/resolution/scoring.js";
import { aCandidate, anEntity } from "../support/knowledge-builders.js";

/** A scored candidate at exactly `score`, so a test states the case it is about. */
function scoredAt(score: number, id = "per-sarah"): ScoredCandidate {
  return {
    candidate: aCandidate({ entity: anEntity({ id }) }),
    score,
    features: { nameSimilarity: score, sourceAgreement: 0, coOccurrence: 0, recency: 0 },
  };
}

describe("resolving to an entity", () => {
  it("matches a clear best candidate", () => {
    const resolution = resolveFromScores([scoredAt(0.95, "per-1"), scoredAt(0.2, "per-2")]);

    expect(resolution.outcome).toBe("matched");
    expect(resolution.entityId).toBe("per-1");
  });

  it("chooses no entity when the best candidate is below the match floor", () => {
    const resolution = resolveFromScores([scoredAt(MATCH_FLOOR - 0.01)]);

    expect(resolution.entityId).toBeNull();
  });
});

/**
 * The distinction Slice 5 pays for. A create after rejecting real candidates
 * goes to review; a create with nothing plausible behind it applies unattended
 * (`triage.md` §3). Collapsing the two would either make first use a form to
 * fill in or fill the graph with duplicate Sarahs.
 */
describe("the two kinds of none-of-these", () => {
  it("reports rejected candidates when plausible ones existed and none was good enough", () => {
    const resolution = resolveFromScores([scoredAt(0.5), scoredAt(0.45, "per-2")]);

    expect(resolution.outcome).toBe("rejected_candidates");
    expect(resolution.entityId).toBeNull();
  });

  it("reports unambiguous when nothing plausible was found", () => {
    const resolution = resolveFromScores([scoredAt(PLAUSIBILITY_FLOOR - 0.01)]);

    expect(resolution.outcome).toBe("unambiguous");
  });

  it("reports unambiguous for an empty shortlist", () => {
    expect(resolveFromScores([]).outcome).toBe("unambiguous");
  });

  /**
   * Not a hedge: the claim is "no entity in the graph is this one", and an
   * empty shortlist is strong evidence for exactly that. A low number would
   * push a first-ever mention toward review.
   */
  it("is fully confident that a first-ever mention is new", () => {
    expect(resolveFromScores([]).confidence).toBe(1);
  });
});

describe("p(resolution)", () => {
  /**
   * `triage.md` §1: the margin between the top two candidates, not the top
   * score. Two near-identical candidates are an uncertain resolution however
   * well either scores.
   */
  it("is the margin between the top two candidates, not the top score", () => {
    const resolution = resolveFromScores([scoredAt(0.95, "per-1"), scoredAt(0.9, "per-2")]);

    expect(resolution.confidence).toBeCloseTo(0.05);
  });

  it("is low for two near-identical candidates even when both score highly", () => {
    const nearIdentical = resolveFromScores([scoredAt(0.98, "per-1"), scoredAt(0.97, "per-2")]);
    const clear = resolveFromScores([scoredAt(0.8, "per-1"), scoredAt(0.2, "per-2")]);

    expect(nearIdentical.confidence).toBeLessThan(clear.confidence);
  });

  /**
   * A lone candidate scoring 0.56 barely cleared the bar and should not be as
   * confident as a lone candidate scoring 0.99. Measuring against zero would
   * make every single-candidate resolution look decisive.
   */
  it("scales a lone candidate's confidence by how far past the floor it got", () => {
    const barely = resolveFromScores([scoredAt(MATCH_FLOOR + 0.01)]);
    const comfortably = resolveFromScores([scoredAt(0.99)]);

    expect(barely.confidence).toBeLessThan(comfortably.confidence);
  });

  it("never leaves the unit interval, whatever the scores", () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 0, max: 1, noNaN: true }), { maxLength: 6 }),
        (scores) => {
          const ordered = [...scores].sort((left, right) => right - left);
          const { confidence } = resolveFromScores(
            ordered.map((score, index) => scoredAt(score, `per-${index}`)),
          );
          expect(confidence).toBeGreaterThanOrEqual(0);
          expect(confidence).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

describe("the ambiguity trigger", () => {
  it("marks a narrow margin ambiguous", () => {
    const resolution = resolveFromScores([scoredAt(0.9, "per-1"), scoredAt(0.85, "per-2")]);

    expect(resolution.isAmbiguous).toBe(true);
  });

  it("does not mark a decisive margin ambiguous", () => {
    const resolution = resolveFromScores([scoredAt(0.9, "per-1"), scoredAt(0.2, "per-2")]);

    expect(resolution.isAmbiguous).toBe(false);
  });

  it("marks ambiguity exactly at the margin threshold", () => {
    const justInside = resolveFromScores([
      scoredAt(0.9, "per-1"),
      scoredAt(0.9 - AMBIGUITY_MARGIN + 0.01, "per-2"),
    ]);

    expect(justInside.isAmbiguous).toBe(true);
  });
});

/**
 * ADR-0009's asymmetry, stated as a property rather than an example: a
 * duplicate is recoverable by merge and a misattribution quietly corrupts
 * knowledge, so the scorer must never match on weak evidence.
 */
describe("the resolution bias", () => {
  it("never matches a candidate below the match floor, at any margin", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: Math.fround(MATCH_FLOOR - 0.01), noNaN: true }),
        (score) => {
          expect(resolveFromScores([scoredAt(score)]).entityId).toBeNull();
        },
      ),
    );
  });

  it("always names an entity when it matches, and never when it does not", () => {
    fc.assert(
      fc.property(fc.float({ min: 0, max: 1, noNaN: true }), (score) => {
        const resolution = resolveFromScores([scoredAt(score)]);
        const isMatched = resolution.outcome === "matched";
        expect(resolution.entityId === null).toBe(!isMatched);
      }),
    );
  });
});
