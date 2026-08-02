import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  applyEvents,
  emptyKnowledge,
  entityOf,
  provenanceOf,
  redirectsIn,
  resolveRedirect,
} from "../../src/domain/knowledge/project-entity.js";
import {
  aFieldSet,
  anEntitiesMerged,
  anEntityCreated,
  aSetMemberAdded,
} from "../support/projection-builders.js";

/**
 * **Folding a merge** (`qa.md` §7.4, ADR-0009, `triage.md` §5).
 *
 * The fold is where a merge shows: nothing in history is rewritten, and the
 * projection is the only thing that changes. These are the semantics the slice
 * turns on — one entity afterwards, the loser resolvable through a redirect, and
 * no value from either side lost.
 */

/** Sarah as two entities, before anyone knows they are one. */
function twoSarahs() {
  const first = applyEvent(emptyKnowledge(), anEntityCreated({ aggregateId: "per-4891" }));
  return applyEvent(
    first,
    anEntityCreated({ aggregateId: "per-4172", payload: { name: "Sarah Chen" } }),
  );
}

describe("folding EntitiesMerged", () => {
  it("leaves one entity where there were two", () => {
    const merged = applyEvent(
      twoSarahs(),
      anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-4172" }),
    );

    expect(entityOf(merged, "per-4172")).toBeDefined();
    expect(entityOf(merged, "per-4891")).toBeUndefined();
  });

  it("records the merged-away identity as a redirect to its survivor", () => {
    const merged = applyEvent(
      twoSarahs(),
      anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-4172" }),
    );

    expect(resolveRedirect(merged, "per-4891")).toBe("per-4172");
  });

  /** An id nothing merged away resolves to itself, so callers need no branch. */
  it("resolves an id that was never merged to itself", () => {
    expect(resolveRedirect(twoSarahs(), "per-4172")).toBe("per-4172");
  });

  /**
   * A merge advances the survivor's version like any other change to it, so a
   * Proposal computed before the merge fails its version check rather than
   * applying against an entity that has since absorbed another.
   */
  it("advances the survivor's version", () => {
    const before = entityOf(twoSarahs(), "per-4172")?.version;
    const merged = applyEvent(
      twoSarahs(),
      anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-4172" }),
    );

    expect(entityOf(merged, "per-4172")?.version).toBe(before! + 1);
  });

  /**
   * A merge naming an entity that does not exist is dropped, for the reason
   * every other fold drops one: a projection that invented entities from a
   * partial log would report entities the log does not contain.
   */
  it("ignores a merge whose survivor was never created", () => {
    const merged = applyEvent(
      emptyKnowledge(),
      anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-nobody" }),
    );

    expect(redirectsIn(merged).size).toBe(0);
  });

  /** Merging an entity into itself is not a merge and must not erase it. */
  it("refuses to merge an entity into itself", () => {
    const merged = applyEvent(
      twoSarahs(),
      anEntitiesMerged({ mergedId: "per-4172" }, { aggregateId: "per-4172" }),
    );

    expect(entityOf(merged, "per-4172")).toBeDefined();
    expect(redirectsIn(merged).size).toBe(0);
  });
});

describe("field conflicts resolve losslessly", () => {
  /**
   * `triage.md` §5: the survivor's value is kept and the loser's moves into
   * `notes`. Lossless is the whole justification for merge shipping without the
   * per-fact classification UI — nothing is dropped, so nothing needs deciding.
   */
  it("keeps the survivor's value and moves the loser's into notes", () => {
    const withEmployers = applyEvents(twoSarahs(), [
      aFieldSet({ field: "employer", value: "Globex" }, { aggregateId: "per-4172" }),
      aFieldSet({ field: "employer", value: "Acme" }, { aggregateId: "per-4891" }),
    ]);

    const merged = applyEvent(
      withEmployers,
      anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-4172" }),
    );

    const survivor = entityOf(merged, "per-4172");
    expect(survivor?.fields["employer"]).toEqual(["Globex"]);
    expect(survivor?.fields["notes"]).toEqual(["employer: Acme"]);
  });

  /** A field only the loser held is not a conflict: the survivor simply gains it. */
  it("adopts a field the survivor did not hold", () => {
    const withRole = applyEvent(
      twoSarahs(),
      aFieldSet({ field: "role", value: "Engineer" }, { aggregateId: "per-4891" }),
    );

    const merged = applyEvent(
      withRole,
      anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-4172" }),
    );

    expect(entityOf(merged, "per-4172")?.fields["role"]).toEqual(["Engineer"]);
    expect(entityOf(merged, "per-4172")?.fields["notes"]).toBeUndefined();
  });

  /** A set field unions rather than conflicting: both sides' members survive. */
  it("unions the members of a set field", () => {
    const withAliases = applyEvents(twoSarahs(), [
      aSetMemberAdded({ field: "aliases", value: "Sarah" }, { aggregateId: "per-4172" }),
      aSetMemberAdded({ field: "aliases", value: "S. Chen" }, { aggregateId: "per-4891" }),
    ]);

    const merged = applyEvent(
      withAliases,
      anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-4172" }),
    );

    expect(entityOf(merged, "per-4172")?.fields["aliases"]).toEqual(["Sarah", "S. Chen"]);
  });

  /**
   * The name is the conflict every merge has, since both sides have one. It
   * follows the same rule as any other single field rather than a special case.
   */
  it("moves the loser's name into notes when the two differ", () => {
    const state = applyEvent(
      applyEvent(emptyKnowledge(), anEntityCreated({ aggregateId: "per-4172" })),
      anEntityCreated({ aggregateId: "per-4891", payload: { name: "Sara Chen" } }),
    );

    const merged = applyEvent(
      state,
      anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-4172" }),
    );

    expect(entityOf(merged, "per-4172")?.fields["name"]).toEqual(["Sarah Chen"]);
    expect(entityOf(merged, "per-4172")?.fields["notes"]).toEqual(["name: Sara Chen"]);
  });

  /** Identical values are not a conflict, and recording one would be noise. */
  it("writes no note when both sides agree", () => {
    const merged = applyEvent(
      twoSarahs(),
      anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-4172" }),
    );

    expect(entityOf(merged, "per-4172")?.fields["notes"]).toBeUndefined();
  });
});

describe("provenance survives a merge", () => {
  /**
   * A field the survivor gains from the loser keeps the pointer to the event
   * that set it — which is on the loser's id, immutably. Losing it would make
   * "why does Otto think this?" unanswerable for exactly the fields a merge
   * moved.
   */
  it("carries the pointer for a field adopted from the loser", () => {
    const withRole = applyEvent(
      twoSarahs(),
      aFieldSet({ field: "role", value: "Engineer" }, { aggregateId: "per-4891" }),
    );
    const expected = provenanceOf(withRole, "per-4891", "role");

    const merged = applyEvent(
      withRole,
      anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-4172" }),
    );

    expect(provenanceOf(merged, "per-4172", "role")).toEqual(expected);
  });

  /**
   * `notes` is the one field a merge can write that no earlier event set, so
   * the merge event is what it points at. The rebuild property asserts no field
   * anywhere lacks a pointer; this says which event the merge's own note names.
   */
  it("points a note the merge wrote at the merge event", () => {
    const withEmployers = applyEvents(twoSarahs(), [
      aFieldSet({ field: "employer", value: "Globex" }, { aggregateId: "per-4172" }),
      aFieldSet({ field: "employer", value: "Acme" }, { aggregateId: "per-4891" }),
    ]);

    const merged = applyEvent(
      withEmployers,
      anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-4172", eventId: "evt-merge" }),
    );

    expect(provenanceOf(merged, "per-4172", "notes")?.eventId).toBe("evt-merge");
  });

  it("keeps the survivor's own pointer for a field it already held", () => {
    const withEmployers = applyEvents(twoSarahs(), [
      aFieldSet({ field: "employer", value: "Globex" }, { aggregateId: "per-4172" }),
      aFieldSet({ field: "employer", value: "Acme" }, { aggregateId: "per-4891" }),
    ]);
    const expected = provenanceOf(withEmployers, "per-4172", "employer");

    const merged = applyEvent(
      withEmployers,
      anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-4172" }),
    );

    expect(provenanceOf(merged, "per-4172", "employer")).toEqual(expected);
  });
});

/**
 * **The property carrying the most rigour in this slice** (`qa.md` §7.4).
 *
 * "Follows chains rather than assuming one hop" is precisely the bug a one-hop
 * implementation passes an example test for, so ADR-0009's own example is the
 * minimum case rather than the test.
 */
describe("redirects are transitive", () => {
  /** A chain of `length` merges, each folding the previous survivor into the next. */
  function aChainOf(length: number) {
    const ids = Array.from({ length: length + 1 }, (_, index) => `per-${index}`);
    let state = applyEvents(
      emptyKnowledge(),
      ids.map((id) => anEntityCreated({ aggregateId: id })),
    );
    for (let step = 0; step < length; step += 1) {
      state = applyEvent(
        state,
        anEntitiesMerged({ mergedId: ids[step]! }, { aggregateId: ids[step + 1]! }),
      );
    }
    return { state, ids };
  }

  it("resolves ADR-0009's own example through two hops", () => {
    const created = applyEvents(emptyKnowledge(), [
      anEntityCreated({ aggregateId: "per-4891" }),
      anEntityCreated({ aggregateId: "per-4172" }),
      anEntityCreated({ aggregateId: "per-5310" }),
    ]);
    const merged = applyEvents(created, [
      anEntitiesMerged({ mergedId: "per-4891" }, { aggregateId: "per-4172" }),
      anEntitiesMerged({ mergedId: "per-4172" }, { aggregateId: "per-5310" }),
    ]);

    expect(resolveRedirect(merged, "per-4891")).toBe("per-5310");
  });

  it("resolves every id in a chain of any length to the final survivor", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (length) => {
        const { state, ids } = aChainOf(length);
        const survivor = ids[length]!;

        for (const id of ids) expect(resolveRedirect(state, id)).toBe(survivor);
      }),
      { numRuns: 100 },
    );
  });

  it("leaves exactly one entity standing however long the chain", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (length) => {
        const { state, ids } = aChainOf(length);

        expect([...state.entities.keys()]).toEqual([ids[length]]);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * A cycle cannot arise from the fold — a merged-away id is gone, so nothing
   * can merge it back — but resolution must terminate regardless, because the
   * redirect map is read from a projection table that a corrupt row could put a
   * cycle into. Terminating on a value is what keeps a bad row from hanging
   * every read.
   */
  it("terminates on a cycle rather than looping", () => {
    const cyclic = {
      ...emptyKnowledge(),
      redirects: new Map([
        ["a", "b"],
        ["b", "a"],
      ]),
    };

    expect(["a", "b"]).toContain(resolveRedirect(cyclic, "a"));
  });
});
