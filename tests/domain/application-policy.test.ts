import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CHANGE_KINDS,
  type ChangeKind,
  permittedDisposition,
} from "../../src/domain/policies/application-policy.js";
import {
  DISPOSITIONS,
  type Disposition,
  isNoMorePermissiveThan,
} from "../../src/domain/policies/disposition.js";

/**
 * `qa.md` §5.1, exhaustive over `triage.md` §3 — "there is no excuse for
 * incomplete coverage here."
 *
 * Every test in this file runs with no fixtures, no database, and no async.
 * That is not incidental: `qa.md` §5.1 says if a test for the application
 * policy needs a database, the policy is in the wrong place.
 */

/** The disposition calibration proposes when confidence cleared the high band. */
const PROPOSED = "auto_apply" as const;

describe("the create row", () => {
  /**
   * The subtle row, and the one place the table is more permissive than a flat
   * reading of "creates are additive". Sending every first-ever mention to
   * review would make the first use of Otto a form to fill in (PRD §4.1).
   */
  it("permits an unambiguous create", () => {
    const kind: ChangeKind = { change: "create", hadRejectedCandidates: false };

    expect(permittedDisposition(PROPOSED, kind)).toBe("auto_apply");
  });

  /**
   * The decision that manufactures duplicates: resolution found a Sarah,
   * scored her, and decided this is a different Sarah.
   */
  it("downgrades a create that rejected candidates", () => {
    const kind: ChangeKind = { change: "create", hadRejectedCandidates: true };

    expect(permittedDisposition(PROPOSED, kind)).toBe("needs_review");
  });
});

describe("the update rows", () => {
  it("permits a field change at the auto floor", () => {
    const kind: ChangeKind = { change: "update_field", floor: "auto" };

    expect(permittedDisposition(PROPOSED, kind)).toBe("auto_apply");
  });

  /** `schema.md` §1's per-field floors: `name` on any entity, `became` relations. */
  it("downgrades a field change at the review floor", () => {
    const kind: ChangeKind = { change: "update_field", floor: "review" };

    expect(permittedDisposition(PROPOSED, kind)).toBe("needs_review");
  });

  it("permits a relation add, which is additive like a field", () => {
    const kind: ChangeKind = { change: "add_relation" };

    expect(permittedDisposition(PROPOSED, kind)).toBe("auto_apply");
  });
});

/**
 * `qa.md` §5.1 in bold: the rule is "never, at any confidence," and the only
 * test that verifies "at any confidence" is one that passes the maximum and
 * still expects a downgrade.
 *
 * The policy never sees a confidence at all, so "at confidence 1.0" is
 * expressed the only way it can be from here — as the disposition a confidence
 * of 1.0 produces, which is `auto_apply`, the most permissive input available.
 */
describe("the destructive rows, at confidence 1.0", () => {
  const DESTRUCTIVE: readonly ChangeKind[] = [
    { change: "remove" },
    { change: "merge" },
    { change: "split" },
  ];

  for (const kind of DESTRUCTIVE) {
    it(`downgrades ${kind.change} even when calibration proposed auto-apply`, () => {
      expect(permittedDisposition("auto_apply", kind)).toBe("needs_review");
    });
  }
});

describe("the properties that outlive the rows", () => {
  /**
   * `qa.md` §5.1: this one property catches a whole class of future bug that
   * row-by-row tests would miss. A row added later that upgrades is caught
   * here without anyone remembering to write a test for it.
   */
  it("is never less restrictive than what it was given, for any kind", () => {
    fc.assert(
      fc.property(anyDisposition(), anyChangeKind(), (proposed, kind) => {
        const permitted = permittedDisposition(proposed, kind);

        expect(isNoMorePermissiveThan(permitted, proposed)).toBe(true);
      }),
    );
  });

  /**
   * A discard is not rescued into a review by a permissive row. The property
   * above covers it, but this states the case the property is most likely to
   * be weakened around.
   */
  it("leaves a discard discarded whatever the kind", () => {
    fc.assert(
      fc.property(anyChangeKind(), (kind) => {
        expect(permittedDisposition("discard", kind)).toBe("discard");
      }),
    );
  });

  it("covers every change kind in the vocabulary", () => {
    for (const change of CHANGE_KINDS) {
      const kinds = kindsFor(change);

      expect(kinds.length, `no case built for ${change}`).toBeGreaterThan(0);
      for (const kind of kinds) {
        expect(DISPOSITIONS).toContain(permittedDisposition(PROPOSED, kind));
      }
    }
  });
});

describe("the structural guarantees", () => {
  /**
   * `qa.md` §5.1: the policy's signature does not accept a Confidence.
   * Structural, and checkable. ADD §3's grep over `domain/` covers the letter
   * of this; asserting it on the policy's own source covers the intent.
   */
  it("names no confidence anywhere in its source", async () => {
    const source = await readFile(
      new URL("../../src/domain/policies/application-policy.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/confidence/i);
  });

  /** Pure means callable with nothing. No import in it may reach outside `domain/`. */
  it("imports nothing outside domain/", async () => {
    const source = await readFile(
      new URL("../../src/domain/policies/application-policy.ts", import.meta.url),
      "utf8",
    );

    const specifiers = [...source.matchAll(/from\s*["']([^"']+)["']/g)].map((match) => match[1]);
    expect(specifiers.filter((specifier) => specifier?.includes("../../"))).toEqual([]);
  });
});

function anyDisposition(): fc.Arbitrary<Disposition> {
  return fc.constantFrom(...DISPOSITIONS);
}

/** Every shape a `ChangeKind` can take, including both sides of each flag. */
function anyChangeKind(): fc.Arbitrary<ChangeKind> {
  return fc.constantFrom(...CHANGE_KINDS.flatMap(kindsFor));
}

function kindsFor(change: (typeof CHANGE_KINDS)[number]): ChangeKind[] {
  if (change === "create") {
    return [
      { change, hadRejectedCandidates: true },
      { change, hadRejectedCandidates: false },
    ];
  }
  if (change === "update_field") {
    return [
      { change, floor: "auto" },
      { change, floor: "review" },
    ];
  }
  return [{ change }];
}
