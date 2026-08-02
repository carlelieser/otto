import { describe, expect, it } from "vitest";
import type { Entity } from "../../src/domain/knowledge/entity.js";
import {
  type MentionToResolve,
  type ResolutionDependencies,
  resolveMention,
} from "../../src/inference/resolution/resolve-capture.js";
import type { AdjudicationRequest } from "../../src/ports/adjudicator.js";
import { anEntity } from "../support/knowledge-builders.js";

const A_MENTION: MentionToResolve = {
  text: "Sarah Chen",
  entityType: "Person",
  noteText: "Coffee with Sarah Chen about Helios.",
  capturedAt: "2026-08-01T09:00:00.000Z",
  coResolvedIds: [],
};

/** Dependencies returning canned candidates and a canned adjudication. */
function dependencies(
  options: {
    exact?: readonly Entity[];
    choice?: number | null;
    onAdjudicate?: (request: AdjudicationRequest) => void;
  } = {},
): ResolutionDependencies {
  return {
    reads: {
      byExactName: async () => options.exact ?? [],
      byFuzzyName: async () => [],
      byNearestEmbedding: async () => [],
    },
    relatedIdsFor: async () => new Map(),
    adjudicate: async (request) => {
      options.onAdjudicate?.(request);
      return {
        chosenIndex: options.choice ?? null,
        provider: "in-memory",
        modelVersion: "canned",
      };
    },
  };
}

/** Two entities named identically, which is what makes a case ambiguous. */
const TWO_SARAHS = [
  anEntity({ id: "per-1", fields: { name: ["Sarah Chen"], summary: ["Colleague at Acme."] } }),
  anEntity({ id: "per-2", fields: { name: ["Sarah Chen"], summary: ["Friend in Lisbon."] } }),
];

describe("resolving a mention", () => {
  it("matches a single clear candidate without adjudicating", async () => {
    const resolved = await resolveMention(A_MENTION, dependencies({ exact: [anEntity()] }));

    expect(resolved.resolution.outcome).toBe("matched");
    expect(resolved.wasAdjudicated).toBe(false);
  });

  it("creates unattended when nothing plausible was found", async () => {
    const resolved = await resolveMention(A_MENTION, dependencies());

    expect(resolved.resolution.outcome).toBe("unambiguous");
    expect(resolved.resolution.entityId).toBeNull();
    expect(resolved.candidateCount).toBe(0);
  });

  it("reports how many candidates were considered", async () => {
    const resolved = await resolveMention(A_MENTION, dependencies({ exact: TWO_SARAHS }));

    expect(resolved.candidateCount).toBe(2);
  });
});

describe("the ambiguity trigger", () => {
  it("adjudicates when two candidates score alike", async () => {
    let wasAsked = false;
    const resolved = await resolveMention(
      A_MENTION,
      dependencies({ exact: TWO_SARAHS, choice: 0, onAdjudicate: () => (wasAsked = true) }),
    );

    expect(wasAsked).toBe(true);
    expect(resolved.wasAdjudicated).toBe(true);
    expect(resolved.resolution.entityId).toBe("per-1");
  });

  /**
   * The commonest correct case in the product: the note names someone by the
   * exact name Otto has recorded, and there is one of them.
   *
   * It must not reach the adjudicator. A Person Otto has met once has no
   * co-occurrence, no recorded contact, and one generation source — so if the
   * corroborating features were needed to clear the match floor, this case
   * would score barely above the bar, look ambiguous, and spend a model call on
   * a decision with no ambiguity in it. That would be the majority of calls.
   */
  it("does not adjudicate a lone exact-name match with no corroborating evidence", async () => {
    let wasAsked = false;
    const resolved = await resolveMention(
      A_MENTION,
      dependencies({
        exact: [anEntity({ fields: { name: ["Sarah Chen"] } })],
        onAdjudicate: () => (wasAsked = true),
      }),
    );

    expect(wasAsked, "a lone exact name is not an ambiguous case").toBe(false);
    expect(resolved.resolution.outcome).toBe("matched");
  });

  /** The adjudicator is for the ambiguous minority, not the path. */
  it("does not adjudicate a decisive case", async () => {
    let wasAsked = false;
    await resolveMention(
      A_MENTION,
      dependencies({ exact: [anEntity()], onAdjudicate: () => (wasAsked = true) }),
    );

    expect(wasAsked).toBe(false);
  });

  it("shows the adjudicator at most four candidates", async () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      anEntity({ id: `per-${index}`, fields: { name: ["Sarah Chen"] } }),
    );
    let shown = 0;
    await resolveMention(
      A_MENTION,
      dependencies({
        exact: many,
        choice: 0,
        onAdjudicate: (request) => (shown = request.candidates.length),
      }),
    );

    expect(shown).toBe(4);
  });

  /**
   * `add.md` §5.3: the adjudicator cannot invent an entity id because the only
   * ids it has seen are none. Verified at the seam rather than assumed.
   */
  it("shows the adjudicator no entity ids", async () => {
    let request: AdjudicationRequest | undefined;
    await resolveMention(
      A_MENTION,
      dependencies({ exact: TWO_SARAHS, choice: 0, onAdjudicate: (asked) => (request = asked) }),
    );

    const serialised = JSON.stringify(request?.candidates);
    expect(serialised).not.toContain("per-1");
    expect(serialised).not.toContain("per-2");
  });

  it("takes a declined adjudication as candidates rejected, not as a match", async () => {
    const resolved = await resolveMention(
      A_MENTION,
      dependencies({ exact: TWO_SARAHS, choice: null }),
    );

    expect(resolved.resolution.outcome).toBe("rejected_candidates");
    expect(resolved.resolution.entityId).toBeNull();
  });
});

/**
 * **The sentence most at risk of being implemented wrong** (`triage.md` §1):
 * an adjudicated pick among near-identical candidates is not made confident by
 * having been adjudicated.
 */
describe("adjudication and confidence", () => {
  it("leaves the confidence at the scorer's margin after adjudicating", async () => {
    const declined = await resolveMention(
      A_MENTION,
      dependencies({ exact: TWO_SARAHS, choice: null }),
    );
    const picked = await resolveMention(A_MENTION, dependencies({ exact: TWO_SARAHS, choice: 0 }));

    expect(picked.resolution.confidence).toBe(declined.resolution.confidence);
  });

  it("does not raise the confidence of a near-identical pair by adjudicating it", async () => {
    const resolved = await resolveMention(
      A_MENTION,
      dependencies({ exact: TWO_SARAHS, choice: 0 }),
    );

    // Two identically-named candidates leave the scorer no margin at all, and
    // a model choosing between them does not create one.
    expect(resolved.resolution.confidence).toBeCloseTo(0);
    expect(resolved.resolution.entityId).toBe("per-1");
  });
});
