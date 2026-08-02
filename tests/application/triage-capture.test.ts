import { beforeEach, describe, expect, it } from "vitest";
import { CREATE_ENTITY, SET_FIELD } from "../../src/domain/commands/knowledge-commands.js";
import { ENTITY_CREATED } from "../../src/domain/events/knowledge-events.js";
import {
  CaptureTriage,
  NO_CORRECTIONS,
  type CorrectionCounts,
} from "../../src/application/pipeline/triage-capture.js";
import { createExecutor, createStorage, type Storage } from "../../src/composition-root.js";
import { BOOTSTRAP_CORRECTIONS } from "../../src/inference/calibration/bootstrap.js";
import { aCommand, aProposal } from "../support/triage-builders.js";

/**
 * The slice's Done-when: **a Proposal becomes an event in the log with no human
 * involved**, when and only when Otto is confident enough and the change is the
 * kind that may happen unattended.
 *
 * Offline integration (`qa.md` §3): the whole triage-to-log path against SQLite
 * in `:memory:`, no network and no Tauri.
 */

const DECIDED_AT = "2026-08-01T09:00:00.000Z";

let storage: Storage;
let triage: CaptureTriage;

/**
 * A draw above every rate, so sampling catches nothing.
 *
 * Needed because sampling is real on this path: at the bootstrap rate of 20%,
 * one run in five would pull a confident create into review and the assertions
 * below would fail for the right reason at the wrong moment. Pinning the draw
 * is not turning sampling off — the test immediately below turns it all the way
 * up and watches it fire.
 */
const NEVER_SAMPLED = () => 1;

/** Triage wired to real storage, with `corrections` standing in for Slice 7. */
function createTriage(
  corrections: CorrectionCounts = NO_CORRECTIONS,
  draw = NEVER_SAMPLED,
): CaptureTriage {
  return new CaptureTriage({
    executor: createExecutor(storage.events, () => DECIDED_AT),
    dispositions: storage.dispositions,
    corrections,
    now: () => DECIDED_AT,
    draw,
  });
}

/** Every event in the log, from the start. `readForward` is the port's only read. */
async function allEvents() {
  return storage.events.readForward(0);
}

beforeEach(() => {
  storage = createStorage();
  triage = createTriage();
  return () => storage.close();
});

/** A confident unambiguous create — the one thing that auto-applies in bootstrap. */
function aConfidentCreate(overrides = {}) {
  return aProposal({
    confidences: { extraction: 0.95, resolution: null },
    resolution: { outcome: "unambiguous", wasAdjudicated: false, candidateCount: 0 },
    ...overrides,
  });
}

describe("the write path completes", () => {
  it("turns a confident create into an event with no human involved", async () => {
    await triage.triageAll([aConfidentCreate()]);

    const events = await allEvents();

    expect(events.map((event) => event.type)).toEqual([ENTITY_CREATED]);
  });

  /** ADR-0006: provenance not recorded at write time is unreconstructable later. */
  it("stamps the event with the Proposal and model that produced it", async () => {
    await triage.triageAll([aConfidentCreate()]);

    const [event] = await allEvents();

    expect(event?.provenance.proposalId).toBe("prop-1");
    expect(event?.provenance.isHumanConfirmed).toBe(false);
  });

  it("writes no event for a proposal that needs review", async () => {
    const middling = aProposal({ confidences: { extraction: 0.7, resolution: null } });

    await triage.triageAll([middling]);

    expect(await allEvents()).toEqual([]);
  });

  it("writes no event for a discard", async () => {
    const low = aProposal({ confidences: { extraction: 0.2, resolution: null } });

    await triage.triageAll([low]);

    expect(await allEvents()).toEqual([]);
  });
});

describe("every decision is recorded", () => {
  it("records each of the three outcomes against its Capture", async () => {
    await triage.triageAll([
      aConfidentCreate({ proposalId: "prop-high" }),
      aProposal({ proposalId: "prop-mid", confidences: { extraction: 0.7, resolution: null } }),
      aProposal({ proposalId: "prop-low", confidences: { extraction: 0.2, resolution: null } }),
    ]);

    const recorded = await storage.dispositions.forCapture("cap-1");

    expect(new Set(recorded.map((r) => r.disposition))).toEqual(
      new Set(["auto_apply", "needs_review", "discard"]),
    );
  });

  /** `triage.md` §7: the discard is visible and names where it came from. */
  it("leaves a discard retrievable and naming its Capture", async () => {
    const low = aProposal({
      proposalId: "prop-low",
      confidences: { extraction: 0.2, resolution: null },
    });

    await triage.triageAll([low]);

    const [discard] = await storage.dispositions.discards(DECIDED_AT);

    expect(discard?.proposalId).toBe("prop-low");
    expect(discard?.captureId).toBe("cap-1");
  });
});

/**
 * `triage.md` §6 through the whole stage: the sampled proposal goes to review
 * instead of the log, and the mark lands in the data where calibration can find
 * it later.
 */
describe("calibration sampling reaches the store", () => {
  it("sends a sampled auto-apply to review and records the mark", async () => {
    const sampling = createTriage(NO_CORRECTIONS, () => 0);

    await sampling.triageAll([aConfidentCreate()]);

    const [recorded] = await storage.dispositions.forCapture("cap-1");
    expect(recorded?.disposition).toBe("needs_review");
    expect(recorded?.wasSampled).toBe(true);
    expect(await allEvents(), "a sampled proposal must not reach the log").toEqual([]);
  });

  /** The unsampled path writes the same row with the mark absent. */
  it("leaves an unsampled auto-apply unmarked", async () => {
    await triage.triageAll([aConfidentCreate()]);

    const [recorded] = await storage.dispositions.forCapture("cap-1");
    expect(recorded?.wasSampled).toBe(false);
  });
});

describe("bootstrap governs what applies unattended", () => {
  /**
   * Slice 5 ships in permanent bootstrap, since Corrections are Slice 7's. This
   * asserts the shipped behaviour rather than a hypothetical one.
   */
  it("withholds a resolution-requiring change while corrections are zero", async () => {
    const resolved = aProposal({
      confidences: { extraction: 1, resolution: 1 },
      command: aCommand({
        type: SET_FIELD,
        payload: { field: "employer", value: "Acme" },
        aggregate: { type: "Entity", id: "per-sarah", expectedVersion: 0 },
      }),
    });

    await triage.triageAll([resolved]);

    expect(await allEvents()).toEqual([]);
  });

  /** The same proposal, past bootstrap, does reach the log. */
  it("applies the same change once corrections have accumulated", async () => {
    const settled = createTriage({ forModel: async () => BOOTSTRAP_CORRECTIONS });
    const resolved = aProposal({
      confidences: { extraction: 1, resolution: 1 },
      command: aCommand({
        type: SET_FIELD,
        payload: { field: "employer", value: "Acme" },
        aggregate: { type: "Entity", id: "per-sarah", expectedVersion: 0 },
      }),
    });

    await settled.triageAll([resolved]);

    expect(await allEvents()).toHaveLength(1);
  });
});

describe("staleness is reported rather than applied blindly", () => {
  /**
   * `triage.md` §8: the target moved while the Proposal waited. The executor
   * refuses it, and triage hands it back for re-proposal rather than letting
   * the failure escape as an error.
   */
  it("returns a stale proposal instead of throwing", async () => {
    await triage.triageAll([aConfidentCreate()]);

    const restated = aConfidentCreate({ proposalId: "prop-2" });
    const { stale } = await triage.triageAll([restated]);

    expect(stale.map((proposal) => proposal.proposalId)).toEqual(["prop-2"]);
  });

  it("records the stale proposal's disposition even though nothing was applied", async () => {
    await triage.triageAll([aConfidentCreate()]);

    await triage.triageAll([aConfidentCreate({ proposalId: "prop-2" })]);

    const recorded = await storage.dispositions.forCapture("cap-1");
    expect(recorded.map((r) => r.proposalId)).toContain("prop-2");
  });
});

describe("the model never reaches the log", () => {
  /**
   * The seam `add.md` §5.4 makes structural, checked at the far end: what lands
   * in the log is an event built from a Command the differ produced, and the
   * payload is exactly what the Command carried.
   */
  it("writes the Command's own payload, unaltered", async () => {
    const create = aConfidentCreate({
      command: aCommand({
        type: CREATE_ENTITY,
        payload: { entityType: "Project", name: "Helios" },
      }),
    });

    await triage.triageAll([create]);

    const [event] = await allEvents();
    expect(event?.payload).toEqual({ entityType: "Project", name: "Helios" });
  });
});
