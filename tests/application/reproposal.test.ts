import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SET_FIELD } from "../../src/domain/commands/knowledge-commands.js";
import { reproposeAgainst } from "../../src/application/pipeline/repropose.js";
import { anEntity } from "../support/knowledge-builders.js";
import { aCommand, aProposal } from "../support/triage-builders.js";

/**
 * `qa.md` §5.6, `triage.md` §8, `add.md` §5.6.
 *
 * The staleness path exists because of **user think-time**, not parallelism: a
 * Proposal sits in the review queue for three days while its target changes
 * underneath it. That is the only place in Otto that needs concurrency control
 * (`qa.md` §2), and this is the recovery it needs.
 */

/** The claimed value the original Proposal was built from, still valid. */
const CLAIMED = [{ field: "employer", value: "Globex" }];

/** A Proposal computed against version 1, setting `employer` to Globex. */
function aStaleProposal() {
  return aProposal({
    command: aCommand({
      type: SET_FIELD,
      payload: { field: "employer", value: "Globex" },
      aggregate: { type: "Entity", id: "per-sarah", expectedVersion: 1 },
    }),
    confidences: { extraction: 1, resolution: null },
  });
}

describe("re-proposal re-enters from the differ", () => {
  /**
   * `qa.md` §5.6 in bold, and asserted as an **absence**: the extracted values
   * are still valid because the text did not change. Only the comparison
   * against current state is stale, which is cheap and involves no LLM call.
   *
   * Asserted structurally rather than by handing in a spy and checking it went
   * uncalled. A spy proves the extractor was not called *on this input*; the
   * source proves there is nothing here that could call it on any input, which
   * is the claim `triage.md` §8 actually makes.
   */
  it("cannot invoke the extractor, having no way to reach one", async () => {
    const source = await readFile(
      new URL("../../src/application/pipeline/repropose.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/ports\/(extractor|adjudicator|embedder)/);
    expect(source).not.toMatch(/\bextract\s*\(/);
  });

  /** The re-proposal is stamped against the version it was actually computed on. */
  it("restamps the command with the current aggregate version", async () => {
    const outcome = await reproposeAgainst(aStaleProposal(), {
      current: anEntity({ version: 7, fields: { employer: ["Acme"] } }),
      claimed: CLAIMED,
    });

    expect(outcome.kind).toBe("changed");
    if (outcome.kind !== "changed") return;
    expect(outcome.proposals[0]?.command.aggregate.expectedVersion).toBe(7);
  });
});

describe("what the re-proposal produces", () => {
  /**
   * `triage.md` §8: the user's own edit already made the change the proposal
   * wanted, so the proposal is satisfied. Recorded as closed rather than shown
   * again — re-queueing it would ask the user to confirm what they just did.
   */
  it("closes a re-proposal that produces no change", async () => {
    const outcome = await reproposeAgainst(aStaleProposal(), {
      current: anEntity({ version: 4, fields: { employer: ["Globex"] } }),
      claimed: CLAIMED,
    });

    expect(outcome.kind).toBe("closed");
  });

  /**
   * The rule that overrides every number in the system: the thing the user was
   * looking at changed underneath them, so a human looks again however sure
   * Otto is. The original here carries maximum confidence and an unambiguous
   * outcome, which would otherwise auto-apply.
   */
  it("reviews a different change regardless of confidence", async () => {
    const outcome = await reproposeAgainst(aStaleProposal(), {
      current: anEntity({ version: 4, fields: { employer: ["Initech"] } }),
      claimed: CLAIMED,
    });

    expect(outcome.kind).toBe("changed");
    if (outcome.kind !== "changed") return;
    expect(outcome.disposition).toBe("needs_review");
  });

  /**
   * The same rule, stated as the property it is: no confidence reaches
   * auto-apply on a re-proposal. Triage is not consulted at all on this path,
   * which is what makes "regardless of confidence" structural rather than a
   * threshold comparison that could later be tuned into being wrong.
   */
  it("never auto-applies a re-proposal at any confidence", async () => {
    for (const extraction of [0, 0.5, 0.9, 0.95, 1]) {
      const proposal = aProposal({
        ...aStaleProposal(),
        confidences: { extraction, resolution: null },
      });

      const outcome = await reproposeAgainst(proposal, {
        current: anEntity({ version: 4, fields: { employer: ["Initech"] } }),
        claimed: CLAIMED,
      });

      expect(outcome.kind === "changed" && outcome.disposition).toBe("needs_review");
    }
  });

  /**
   * A re-diff can imply more than one change, and dropping the extra ones is
   * silent in the worst way: `schema.md` §4 has `blocker` cleared by a status
   * change away from `blocked`, so keeping only the first change would leave a
   * Project unblocked with the stale reason it was blocked still attached.
   */
  it("carries every change a re-diff implies, not just the first", async () => {
    const blocked = anEntity({
      id: "prj-helios",
      type: "Project",
      version: 4,
      fields: { status: ["blocked"], blocker: ["waiting on legal"] },
    });

    const outcome = await reproposeAgainst(aStaleProposal(), {
      current: blocked,
      claimed: [{ field: "status", value: "active" }],
    });

    expect(outcome.kind).toBe("changed");
    if (outcome.kind !== "changed") return;
    const changed = outcome.proposals.map((p) => p.command.payload);
    expect(changed).toContainEqual({ field: "status", value: "active" });
    expect(changed).toContainEqual({ field: "blocker", because: "status" });
  });

  /** Every re-proposal in a multi-change set is stamped against current state. */
  it("stamps every carried change with the current version", async () => {
    const blocked = anEntity({
      id: "prj-helios",
      type: "Project",
      version: 9,
      fields: { status: ["blocked"], blocker: ["waiting on legal"] },
    });

    const outcome = await reproposeAgainst(aStaleProposal(), {
      current: blocked,
      claimed: [{ field: "status", value: "active" }],
    });

    expect(outcome.kind).toBe("changed");
    if (outcome.kind !== "changed") return;
    const versions = outcome.proposals.map((p) => p.command.aggregate.expectedVersion);
    expect(new Set(versions)).toEqual(new Set([9]));
  });

  /** A target that vanished cannot be re-proposed against anything. */
  it("closes a re-proposal whose target no longer exists", async () => {
    const outcome = await reproposeAgainst(aStaleProposal(), {
      current: undefined,
      claimed: CLAIMED,
    });

    expect(outcome.kind).toBe("closed");
  });
});
