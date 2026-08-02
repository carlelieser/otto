import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ADD_TO_SET,
  CLEAR_FIELD,
  CREATE_ENTITY,
  RELATE,
  SET_FIELD,
} from "../../src/domain/commands/knowledge-commands.js";
import { DISPOSITIONS, isNoMorePermissiveThan } from "../../src/domain/policies/disposition.js";
import { changeKindOf, triage } from "../../src/inference/calibration/triage.js";
import { BOOTSTRAP_CORRECTIONS } from "../../src/inference/calibration/bootstrap.js";
import { aCommand, aProposal } from "../support/triage-builders.js";

/**
 * The wiring of `add.md` §5.5: **calibration proposes a disposition, the domain
 * policy may downgrade it, and control flows one way.**
 *
 * The two halves are tested exhaustively in their own files — `thresholds`,
 * `bootstrap`, `sampling`, and `application-policy`. What is tested here is
 * that they are joined in the right order and that nothing upgrades on the way
 * through.
 */

/** Sampling off for a test that is not about sampling. Never a production path. */
const NEVER_SAMPLED = () => 1;
const ALWAYS_SAMPLED = () => 0;

const SETTLED = { correctionCount: BOOTSTRAP_CORRECTIONS, draw: NEVER_SAMPLED };

describe("the bands, end to end", () => {
  it("auto-applies a confident create", () => {
    const proposal = aProposal({ confidences: { extraction: 0.95, resolution: null } });

    expect(triage(proposal, SETTLED).disposition).toBe("auto_apply");
  });

  it("reviews a middling proposal", () => {
    const proposal = aProposal({ confidences: { extraction: 0.8, resolution: null } });

    expect(triage(proposal, SETTLED).disposition).toBe("needs_review");
  });

  it("discards a proposal below the floor", () => {
    const proposal = aProposal({ confidences: { extraction: 0.3, resolution: null } });

    expect(triage(proposal, SETTLED).disposition).toBe("discard");
  });
});

describe("the policy downgrades what calibration proposed", () => {
  /**
   * The row that matters most: a maximally confident destructive change still
   * waits for a human. `remove` reaches triage as a `ClearField` Command.
   */
  it("reviews a maximally confident clear", () => {
    const proposal = aProposal({
      confidences: { extraction: 1, resolution: null },
      command: aCommand({ type: CLEAR_FIELD, payload: { field: "blocker", because: "status" } }),
    });

    expect(triage(proposal, SETTLED).disposition).toBe("needs_review");
  });

  /** The create that rejected candidates — the decision that makes duplicates. */
  it("reviews a confident create that rejected candidates", () => {
    const proposal = aProposal({
      confidences: { extraction: 1, resolution: null },
      resolution: { outcome: "rejected_candidates", wasAdjudicated: false, candidateCount: 3 },
    });

    expect(triage(proposal, SETTLED).disposition).toBe("needs_review");
  });

  /** The same confidence, unambiguous: nothing plausible existed to be wrong about. */
  it("auto-applies a confident create that found no candidates", () => {
    const proposal = aProposal({
      confidences: { extraction: 1, resolution: null },
      resolution: { outcome: "unambiguous", wasAdjudicated: false, candidateCount: 0 },
    });

    expect(triage(proposal, SETTLED).disposition).toBe("auto_apply");
  });

  /** `name` carries a `review` floor in `schema.md` §1, read from the schema. */
  it("reviews a confident rename", () => {
    const proposal = aProposal({
      confidences: { extraction: 1, resolution: null },
      command: aCommand({ type: SET_FIELD, payload: { field: "name", value: "Sarah Chen" } }),
    });

    expect(triage(proposal, SETTLED).disposition).toBe("needs_review");
  });
});

describe("bootstrap, wired", () => {
  /**
   * `qa.md` §5.4: maximum on both figures, still not unattended. Slice 5 ships
   * in permanent bootstrap because Corrections are Slice 7's, so this is the
   * ordinary path rather than an edge case.
   */
  it("withholds a resolution-requiring proposal at maximum confidence", () => {
    const proposal = aProposal({
      confidences: { extraction: 1, resolution: 1 },
      command: aCommand({ type: SET_FIELD, payload: { field: "employer", value: "Acme" } }),
    });

    const { disposition } = triage(proposal, { correctionCount: 0, draw: NEVER_SAMPLED });

    expect(disposition).toBe("needs_review");
  });

  it("still auto-applies an unambiguous create during bootstrap", () => {
    const proposal = aProposal({ confidences: { extraction: 1, resolution: null } });

    const { disposition } = triage(proposal, { correctionCount: 0, draw: NEVER_SAMPLED });

    expect(disposition).toBe("auto_apply");
  });
});

describe("sampling, wired as a downgrade", () => {
  it("sends a sampled auto-apply to review and marks it", () => {
    const proposal = aProposal({ confidences: { extraction: 0.95, resolution: null } });

    const triaged = triage(proposal, { correctionCount: 0, draw: ALWAYS_SAMPLED });

    expect(triaged.disposition).toBe("needs_review");
    expect(triaged.wasSampled).toBe(true);
  });

  /**
   * Sampling measures the auto-apply band, so it has nothing to say about a
   * proposal that was never going to auto-apply. Marking one would put an
   * unsampled adjudication into the sampled population and bias the only
   * unbiased number Otto has.
   */
  it("does not mark a proposal that was already going to review", () => {
    const proposal = aProposal({ confidences: { extraction: 0.8, resolution: null } });

    const triaged = triage(proposal, { correctionCount: 0, draw: ALWAYS_SAMPLED });

    expect(triaged.disposition).toBe("needs_review");
    expect(triaged.wasSampled).toBe(false);
  });

  it("does not rescue a discard into review", () => {
    const proposal = aProposal({ confidences: { extraction: 0.1, resolution: null } });

    const triaged = triage(proposal, { correctionCount: 0, draw: ALWAYS_SAMPLED });

    expect(triaged.disposition).toBe("discard");
    expect(triaged.wasSampled).toBe(false);
  });

  /**
   * The mark is in the data and says nothing about how it should be shown.
   * `triage.md` §6 requires sampled proposals to appear in the queue
   * indistinguishably from ordinary ones, so nothing here may carry a label,
   * a reason, or a priority a surface could render.
   */
  it("marks with a plain flag and nothing a surface could render", () => {
    const triaged = triage(aProposal(), { correctionCount: 0, draw: ALWAYS_SAMPLED });

    expect(typeof triaged.wasSampled).toBe("boolean");
    expect(Object.keys(triaged).filter((key) => /sampl/i.test(key))).toEqual(["wasSampled"]);
  });
});

describe("control flows one way", () => {
  /**
   * The property that outlives every row: whatever the confidences, whatever
   * the command, triage's answer is never more permissive than the band the
   * numbers alone would have given.
   */
  it("never returns something more permissive than the band alone", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
        anyKnowledgeCommand(),
        (extraction, resolution, command) => {
          const proposal = aProposal({ confidences: { extraction, resolution }, command });

          const { disposition, bandDisposition } = triage(proposal, SETTLED);

          expect(isNoMorePermissiveThan(disposition, bandDisposition)).toBe(true);
        },
      ),
    );
  });

  it("always answers with a disposition from the vocabulary", () => {
    fc.assert(
      fc.property(anyKnowledgeCommand(), (command) => {
        expect(DISPOSITIONS).toContain(triage(aProposal({ command }), SETTLED).disposition);
      }),
    );
  });
});

describe("reading a change kind off a Command", () => {
  it("calls a CreateEntity a create, carrying what resolution decided", () => {
    const kind = changeKindOf(
      aProposal({
        command: aCommand({
          type: CREATE_ENTITY,
          payload: { entityType: "Person", name: "Sarah" },
        }),
        resolution: { outcome: "rejected_candidates", wasAdjudicated: false, candidateCount: 2 },
      }),
    );

    expect(kind).toEqual({ change: "create", hadRejectedCandidates: true });
  });

  it("calls a Relate an added relation", () => {
    const kind = changeKindOf(
      aProposal({
        command: aCommand({
          type: RELATE,
          payload: {
            relation: "knows",
            fromId: "per-sarah",
            fromType: "Person",
            toId: "per-amir",
            toType: "Person",
          },
        }),
      }),
    );

    expect(kind).toEqual({ change: "add_relation" });
  });

  it("calls a ClearField a remove", () => {
    const kind = changeKindOf(
      aProposal({
        command: aCommand({ type: CLEAR_FIELD, payload: { field: "blocker", because: "status" } }),
      }),
    );

    expect(kind).toEqual({ change: "remove" });
  });

  /** The floor comes from `schema.md` via the entity type, not from a list here. */
  it("reads a field change's floor from the schema", () => {
    const renamed = changeKindOf(
      aProposal({
        command: aCommand({ type: SET_FIELD, payload: { field: "name", value: "Sarah" } }),
      }),
    );
    const noted = changeKindOf(
      aProposal({
        command: aCommand({ type: ADD_TO_SET, payload: { field: "notes", value: "a note" } }),
      }),
    );

    expect(renamed).toEqual({ change: "update_field", floor: "review" });
    expect(noted).toEqual({ change: "update_field", floor: "auto" });
  });
});

/** One command of each knowledge type, for the properties above. */
function anyKnowledgeCommand() {
  return fc.constantFrom(
    aCommand({ type: CREATE_ENTITY, payload: { entityType: "Person", name: "Sarah" } }),
    aCommand({ type: SET_FIELD, payload: { field: "name", value: "Sarah Chen" } }),
    aCommand({ type: SET_FIELD, payload: { field: "employer", value: "Acme" } }),
    aCommand({ type: ADD_TO_SET, payload: { field: "notes", value: "a note" } }),
    aCommand({ type: CLEAR_FIELD, payload: { field: "blocker", because: "status" } }),
    aCommand({
      type: RELATE,
      payload: {
        relation: "knows",
        fromId: "per-sarah",
        fromType: "Person",
        toId: "per-amir",
        toType: "Person",
      },
    }),
  );
}
