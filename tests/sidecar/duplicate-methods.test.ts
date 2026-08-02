import { beforeEach, describe, expect, it } from "vitest";
import {
  createAdjudication,
  createBootstrapStatus,
  createDuplicateDetection,
  createProjectionWorker,
  createReviewQueue,
  createStorage,
  type Storage,
} from "../../src/composition-root.js";
import type { ProjectionWorker } from "../../src/application/projection/projection-worker.js";
import { MERGE_ENTITIES } from "../../src/domain/commands/knowledge-commands.js";
import { dispatch, type Methods } from "../../src/interfaces/sidecar/dispatch.js";
import { reviewMethods } from "../../src/interfaces/sidecar/review-methods.js";

/**
 * **The duplicate sweep over the transport, and the merge the user confirms**
 * (`qa.md` §7.4).
 *
 * The path a user actually takes: a sweep finds a pair, the pair appears in the
 * queue like any other entry, and confirming it merges the two. Every step over
 * the real JSON-RPC boundary, because a merge reachable by any other route is
 * the thing this slice must not have built.
 */

const AT = "2026-08-02T09:00:00.000Z";

let storage: Storage;
let methods: Methods;
let worker: ProjectionWorker;

async function call(method: string, params: unknown = {}): Promise<unknown> {
  const line = JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 });
  const response = await dispatch(line, methods);
  if (response === null) return undefined;
  if ("error" in response) throw new Error(response.error.message);
  return response.result;
}

beforeEach(() => {
  storage = createStorage();
  methods = reviewMethods(
    createReviewQueue(storage),
    createAdjudication(storage, () => AT),
    createBootstrapStatus(storage),
    createDuplicateDetection(storage, () => AT),
  );
  worker = createProjectionWorker(storage);
  return () => storage.close();
});

/** Two Sarahs in the projection, a transcription error apart. */
function givenTwoSarahs(): void {
  storage.entities.putEntity({
    id: "per-4172",
    type: "Person",
    fields: { name: ["Sarah Chen"] },
    version: 1,
  });
  storage.entities.putEntity({
    id: "per-4891",
    type: "Person",
    fields: { name: ["Sara Chen"] },
    version: 1,
  });
}

describe("the duplicate sweep over the transport", () => {
  it("reports the pairs it found", async () => {
    givenTwoSarahs();

    const found = (await call("sweepDuplicates")) as { mergedId: string }[];

    expect(found.map((pair) => pair.mergedId)).toEqual(["per-4891"]);
  });

  it("puts the pair in the review queue like any other entry", async () => {
    givenTwoSarahs();
    await call("sweepDuplicates");

    const { data } = (await call("listAwaitingReview")) as {
      data: { command: { type: string } }[];
    };

    expect(data.map((entry) => entry.command.type)).toEqual([MERGE_ENTITIES]);
  });

  /**
   * **Done when**: a suspected duplicate pair appears in the review queue and
   * the user's confirmation merges them — end to end, over the transport.
   */
  it("merges the pair when the user confirms it", async () => {
    givenTwoSarahs();
    await call("sweepDuplicates");
    const { data } = (await call("listAwaitingReview")) as { data: { proposalId: string }[] };

    await call("confirmProposal", { proposalId: data[0]?.proposalId });
    await worker.catchUp();

    const view = await storage.views.entityView("per-4172");
    expect(view?.entity.fields["notes"]).toEqual(["name: Sara Chen"]);
    expect((await storage.views.entitiesOfType("Person")).map((one) => one.id)).toEqual([
      "per-4172",
    ]);
  });

  /** The merged-away id still resolves, which is what a redirect is for. */
  it("leaves the merged-away id resolvable to the survivor", async () => {
    givenTwoSarahs();
    await call("sweepDuplicates");
    const { data } = (await call("listAwaitingReview")) as { data: { proposalId: string }[] };

    await call("confirmProposal", { proposalId: data[0]?.proposalId });
    await worker.catchUp();

    expect(storage.views.resolveId("per-4891")).toBe("per-4172");
  });

  it("applies nothing unattended", async () => {
    givenTwoSarahs();
    await call("sweepDuplicates");

    const { data } = (await call("listAppliedRecords")) as { data: unknown[] };

    expect(data).toEqual([]);
  });
});
