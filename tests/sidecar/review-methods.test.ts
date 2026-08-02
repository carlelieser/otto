import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionWorker } from "../../src/application/projection/projection-worker.js";
import { CaptureTriage } from "../../src/application/pipeline/triage-capture.js";
import {
  createAdjudication,
  createBootstrapStatus,
  createCorrectionCounts,
  createExecutor,
  createProjectionWorker,
  createReviewQueue,
  createStorage,
  type Storage,
} from "../../src/composition-root.js";
import { SET_FIELD } from "../../src/domain/commands/knowledge-commands.js";
import { dispatch } from "../../src/interfaces/sidecar/dispatch.js";
import { reviewMethods } from "../../src/interfaces/sidecar/review-methods.js";
import type { Methods } from "../../src/interfaces/sidecar/dispatch.js";
import { A_MODEL, aCommand, aProposal } from "../support/triage-builders.js";

/**
 * **`qa.md` §10's second E2E path: review-queue adjudication to applied event.**
 *
 * One of only two E2E paths in the whole plan, justified because the full write
 * path through the UI is itself the thing under test — a queue read over the
 * transport, an adjudication over the transport, and an event in the log at the
 * end of it.
 */

const AT = "2026-08-02T09:00:00.000Z";

let storage: Storage;
let methods: Methods;
let worker: ProjectionWorker;

/**
 * One call over the real transport: a JSON line in, a parsed result out.
 *
 * Through `dispatch` and the string boundary rather than against the surface
 * directly, because the full write path *through the UI* is what `qa.md` §10
 * says is under test here. A helper calling the method object would skip the
 * serialisation the client actually does.
 */
async function call(method: string, params: unknown = {}): Promise<unknown> {
  const line = JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 });
  const response = await dispatch(line, methods);
  if (response === null) return undefined;
  if ("error" in response) throw new Error(response.error.message);
  return response.result;
}

beforeEach(async () => {
  storage = createStorage();
  methods = reviewMethods(
    createReviewQueue(storage),
    createAdjudication(storage, () => AT),
    createBootstrapStatus(storage),
  );
  worker = createProjectionWorker(storage);
  return () => storage.close();
});

/**
 * Triage with the sampling draw pinned above every rate.
 *
 * Sampling is real on this path: at the bootstrap rate of 20%, one run in five
 * would pull a confident create into review and the applied-records assertions
 * would fail for the right reason at the wrong moment. Pinning the draw is not
 * turning sampling off — no value of it stops sampling, only which proposals it
 * catches (`triage.md` §6). The production helper takes no draw, which is why
 * this constructs the stage directly.
 */
function pinnedTriage(): CaptureTriage {
  return new CaptureTriage({
    executor: createExecutor(storage.events, () => AT),
    dispositions: storage.dispositions,
    queue: storage.queue,
    corrections: createCorrectionCounts(storage),
    now: () => AT,
    draw: () => 1,
  });
}

/** A middling proposal, which lands in review rather than applying unattended. */
function aReviewable() {
  return aProposal({
    confidences: { extraction: 0.7, resolution: 0.8 },
    resolution: { outcome: "matched", wasAdjudicated: false, candidateCount: 2 },
  });
}

async function queueOne(): Promise<void> {
  await pinnedTriage().triageAll([aReviewable()]);
}

describe("the queue over the transport", () => {
  it("lists what is awaiting review", async () => {
    await queueOne();

    const { data } = (await call("listAwaitingReview")) as { data: { proposalId: string }[] };

    expect(data.map((entry) => entry.proposalId)).toEqual(["prop-1"]);
  });

  /** Both halves of ADR-0006's rule, at the outermost boundary the user reaches. */
  it("leaks no sampling mark to the client", async () => {
    await queueOne();

    const result = await call("listAwaitingReview");

    expect(JSON.stringify(result)).not.toMatch(/sampl/i);
  });

  it("reports bootstrap status for a named model", async () => {
    const report = (await call("bootstrapStatus", A_MODEL)) as { isBootstrapping: boolean };

    expect(report.isBootstrapping).toBe(true);
  });

  it("refuses a bootstrap request naming no model", async () => {
    await expect(call("bootstrapStatus", {})).rejects.toThrow(/provider/);
  });
});

/** The E2E path proper: adjudicate from the queue, land an event in the log. */
describe("adjudication to applied event", () => {
  it("confirms a proposal and appends the event it implies", async () => {
    await queueOne();

    await call("confirmProposal", { proposalId: "prop-1" });

    const [stored] = await storage.events.readForward(0, 10);
    expect(stored?.type).toBe("EntityCreated");
    expect(stored?.provenance.isHumanConfirmed).toBe(true);
  });

  it("corrects a proposal and appends the chosen change instead", async () => {
    await queueOne();

    await call("correctProposal", {
      proposalId: "prop-1",
      chosen: aCommand({
        type: SET_FIELD,
        aggregate: { type: "Entity", id: "per-other-sarah", expectedVersion: 0 },
        payload: { field: "employer", value: "Globex" },
      }),
    });

    const [stored] = await storage.events.readForward(0, 10);
    expect(stored?.type).toBe("FieldSet");
    expect(stored?.aggregate.id).toBe("per-other-sarah");
  });

  /**
   * The slice's "auto-applied changes are visible in the queue **and
   * correctable**", exercised the way a client actually would: the chosen
   * Command is built from what `listAppliedRecords` returned, and that view
   * exposes no version to stamp with.
   */
  it("corrects an auto-applied record using only what the queue showed", async () => {
    await pinnedTriage().triageAll([
      aProposal({
        confidences: { extraction: 0.95, resolution: null },
        resolution: { outcome: "unambiguous", wasAdjudicated: false, candidateCount: 0 },
      }),
    ]);
    const { data } = (await call("listAppliedRecords")) as {
      data: { proposalId: string; command: { aggregate: { id: string } } }[];
    };
    const record = data[0]!;

    await call("correctProposal", {
      proposalId: record.proposalId,
      chosen: {
        type: SET_FIELD,
        aggregate: { type: "Entity", id: record.command.aggregate.id, expectedVersion: 0 },
        payload: { field: "employer", value: "Globex" },
      },
    });

    const log = await storage.events.readForward(0, 10);
    expect(log.map((event) => event.type)).toEqual(["EntityCreated", "FieldSet"]);
  });

  it("records the counterfactual for calibration", async () => {
    await queueOne();

    await call("correctProposal", {
      proposalId: "prop-1",
      chosen: aCommand({ type: SET_FIELD, payload: { field: "employer", value: "Globex" } }),
    });

    expect(await storage.corrections.countForModel(A_MODEL.provider, A_MODEL.modelVersion)).toBe(1);
  });

  /** A correction whose counterfactual did not survive the trip is a rejection flag. */
  it("refuses a correction that names no chosen Command", async () => {
    await queueOne();

    await expect(call("correctProposal", { proposalId: "prop-1" })).rejects.toThrow(/chosen/);
  });

  it("refuses adjudicating a Proposal the queue does not hold", async () => {
    await expect(call("confirmProposal", { proposalId: "prop-nothing" })).rejects.toThrow(
      /prop-nothing/,
    );
  });
});

/**
 * **`qa.md` §10, staleness end to end.** Approve a proposal, assert the UI
 * reflects it immediately, assert it still reflects it after the projection
 * catches up, and assert it does not double-apply or flicker.
 */
describe("staleness end to end", () => {
  it("reflects the approval immediately, before the projection has folded", async () => {
    await queueOne();

    await call("confirmProposal", { proposalId: "prop-1" });

    expect(await storage.events.readForward(0, 10)).toHaveLength(1);
    const { data } = (await call("listAwaitingReview")) as { data: unknown[] };
    expect(data).toEqual([]);
  });

  it("still reflects it after the projection catches up", async () => {
    await queueOne();
    await call("confirmProposal", { proposalId: "prop-1" });

    await worker.catchUp();

    const { data } = (await call("listAwaitingReview")) as { data: unknown[] };
    expect(data).toEqual([]);
    expect((await storage.views.entityView("per-sarah"))?.entity.id).toBe("per-sarah");
  });

  /**
   * The flicker case: the entry must not reappear in the waiting list once the
   * projection lands, which is what a surface reading its state from the
   * projection rather than from the adjudication would do.
   */
  it("does not double-apply when the projection catches up", async () => {
    await queueOne();
    await call("confirmProposal", { proposalId: "prop-1" });

    await worker.catchUp();
    await worker.catchUp();

    expect(await storage.events.readForward(0, 10)).toHaveLength(1);
  });

  /**
   * The flicker proper: the entry must not reappear in the waiting list once
   * the projection lands. A surface reading its state from the projection
   * rather than from the adjudication would show it again in between.
   */
  it("does not let the answered entry reappear as the projection folds", async () => {
    await queueOne();
    await call("confirmProposal", { proposalId: "prop-1" });

    const readings = [(await call("listAwaitingReview")) as { data: unknown[] }];
    await worker.catchUp();
    readings.push((await call("listAwaitingReview")) as { data: unknown[] });
    await worker.catchUp();
    readings.push((await call("listAwaitingReview")) as { data: unknown[] });

    expect(readings.map((reading) => reading.data.length)).toEqual([0, 0, 0]);
  });

  /**
   * A repeated confirm from a retried click must not append a second event —
   * and must not report a stale target either, since nothing is stale.
   */
  it("does not append twice when the same confirmation arrives again", async () => {
    await queueOne();
    await call("confirmProposal", { proposalId: "prop-1" });

    await expect(call("confirmProposal", { proposalId: "prop-1" })).resolves.toBeUndefined();

    expect(await storage.events.readForward(0, 10)).toHaveLength(1);
  });

  it("reports the projection's freshness alongside the queue", async () => {
    await queueOne();

    const { freshness } = (await call("listAwaitingReview")) as {
      freshness: { isRebuilding: boolean };
    };

    expect(freshness.isRebuilding).toBe(false);
  });
});

/**
 * `qa.md` §5.7 at the transport: the discard surface exposes **no apply path**.
 * Asserted over the method table itself, because an absent method is not
 * something a call can demonstrate.
 */
describe("the discard section over the transport", () => {
  it("lists discards with no Command to act on", async () => {
    await pinnedTriage().triageAll([
      aProposal({ proposalId: "prop-low", confidences: { extraction: 0.2, resolution: 0.3 } }),
    ]);

    const { data } = (await call("listDiscards", { asOf: AT })) as { data: object[] };

    expect(data).toHaveLength(1);
    expect(data[0]).not.toHaveProperty("command");
  });

  it("offers no method that applies or restores a discard", () => {
    const names = Object.keys(methods);

    expect(names.filter((name) => /discard/i.test(name))).toEqual(["listDiscards"]);
    expect(names.filter((name) => /apply|restore/i.test(name))).toEqual([]);
  });
});
