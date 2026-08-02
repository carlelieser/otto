import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionWorker } from "../../src/application/projection/projection-worker.js";
import { ProposalAdjudication } from "../../src/application/pipeline/adjudicate-proposal.js";
import { ReviewQueue } from "../../src/application/surface/read-review-queue.js";
import { KnowledgeReads } from "../../src/application/surface/read-knowledge.js";
import {
  createAdjudication,
  createProjectionWorker,
  createStorage,
  type Storage,
} from "../../src/composition-root.js";
import { MERGE_ENTITIES, SET_FIELD } from "../../src/domain/commands/knowledge-commands.js";
import type { QueuedProposal } from "../../src/ports/review-queue-store.js";
import { aProposal } from "../support/triage-builders.js";
import { anEntitiesMerged, anEntityCreated } from "../support/projection-builders.js";

/**
 * **A merge confirmed from the queue, and what still resolves afterwards**
 * (`qa.md` §7.4, ADR-0009).
 *
 * The two places a dead id can still be encountered, both of which must resolve
 * to the survivor: a proposal queued before the merge and approved a week after,
 * and provenance display for an event whose target is, immutably, the old id.
 * Neither requires the merge to have touched the review queue.
 */

const QUEUED_AT = "2026-08-01T09:00:00.000Z";
const ANSWERED_AT = "2026-08-08T09:00:00.000Z";

let storage: Storage;
let adjudication: ProposalAdjudication;
let queue: ReviewQueue;
let reads: KnowledgeReads;
let worker: ProjectionWorker;

beforeEach(() => {
  storage = createStorage();
  adjudication = createAdjudication(storage, () => ANSWERED_AT);
  queue = new ReviewQueue(storage.queue, storage.dispositions, storage.projections);
  reads = new KnowledgeReads(storage.views, storage.projections);
  worker = createProjectionWorker(storage);
  return () => storage.close();
});

/** A queue entry holding `command`, waiting for the user since `QUEUED_AT`. */
function anEntry(
  proposalId: string,
  command: QueuedProposal["proposal"]["command"],
): QueuedProposal {
  return {
    proposal: aProposal({ proposalId, command }),
    disposition: "needs_review",
    confidence: 0.8,
    wasSampled: false,
    adjudicatedAt: null,
    queuedAt: QUEUED_AT,
  };
}

/** Two Sarahs in the log and the projection, not yet merged. */
async function givenTwoSarahs(): Promise<void> {
  await storage.events.append([
    anEntityCreated({ aggregateId: "per-4172" }),
    anEntityCreated({ aggregateId: "per-4891", payload: { name: "Sara Chen" } }),
  ]);
  await worker.catchUp();
}

/** #4891 merged into #4172, folded into the projection. */
async function whenMerged(survivorId = "per-4172", mergedId = "per-4891"): Promise<void> {
  await storage.events.append([anEntitiesMerged({ mergedId }, { aggregateId: survivorId })]);
  await worker.catchUp();
}

describe("confirming a suspected duplicate", () => {
  it("merges the pair the user confirmed", async () => {
    await givenTwoSarahs();
    await storage.queue.put([
      anEntry("dup-1", {
        type: MERGE_ENTITIES,
        aggregate: { type: "Entity", id: "per-4172", expectedVersion: 0 },
        payload: { mergedId: "per-4891" },
        provenance: aProposal().command.provenance,
      }),
    ]);

    await adjudication.confirm("dup-1");
    await worker.catchUp();

    const { data } = await reads.entitiesOfType("Person");
    expect(data.map((person) => person.id)).toEqual(["per-4172"]);
  });

  /**
   * The merged-away id is gone from every list view and still *resolvable*,
   * which is the whole of what a redirect is. Asserting the view returns nothing
   * would be asserting the opposite of ADR-0009.
   */
  it("keeps the merged-away id resolvable while showing it nowhere", async () => {
    await givenTwoSarahs();
    await storage.queue.put([
      anEntry("dup-1", {
        type: MERGE_ENTITIES,
        aggregate: { type: "Entity", id: "per-4172", expectedVersion: 0 },
        payload: { mergedId: "per-4891" },
        provenance: aProposal().command.provenance,
      }),
    ]);

    await adjudication.confirm("dup-1");
    await worker.catchUp();

    expect((await reads.entityView("per-4891")).data?.entity.id).toBe("per-4172");
  });
});

describe("a proposal queued before a merge", () => {
  /**
   * The case ADR-0009 uses transitive redirects to make cheap: the merge never
   * touched the review queue, and a week later the entry still applies — to the
   * survivor, because that is what its target now resolves to.
   */
  it("applies to the survivor when approved after the merge", async () => {
    await givenTwoSarahs();
    await storage.queue.put([
      anEntry("prop-old", {
        type: SET_FIELD,
        aggregate: { type: "Entity", id: "per-4891", expectedVersion: 1 },
        payload: { field: "employer", value: "Acme" },
        provenance: aProposal().command.provenance,
      }),
    ]);

    await whenMerged();
    await adjudication.confirm("prop-old");
    await worker.catchUp();

    const { data } = await reads.entityView("per-4172");
    expect(data?.entity.fields["employer"]).toEqual(["Acme"]);
  });

  /** Through a chain, not just one hop: the merge may itself have been merged. */
  it("applies to the final survivor through a chain of merges", async () => {
    await givenTwoSarahs();
    await storage.events.append([anEntityCreated({ aggregateId: "per-5310" })]);
    await worker.catchUp();
    await storage.queue.put([
      anEntry("prop-old", {
        type: SET_FIELD,
        aggregate: { type: "Entity", id: "per-4891", expectedVersion: 1 },
        payload: { field: "employer", value: "Acme" },
        provenance: aProposal().command.provenance,
      }),
    ]);

    await whenMerged("per-4172", "per-4891");
    await whenMerged("per-5310", "per-4172");
    await adjudication.confirm("prop-old");
    await worker.catchUp();

    const { data } = await reads.entityView("per-5310");
    expect(data?.entity.fields["employer"]).toEqual(["Acme"]);
  });

  /** The merge itself never had to touch the queue: the entry is as it was. */
  it("is untouched by the merge that happened while it waited", async () => {
    await givenTwoSarahs();
    await storage.queue.put([
      anEntry("prop-old", {
        type: SET_FIELD,
        aggregate: { type: "Entity", id: "per-4891", expectedVersion: 1 },
        payload: { field: "employer", value: "Acme" },
        provenance: aProposal().command.provenance,
      }),
    ]);
    const before = await storage.queue.get("prop-old");

    await whenMerged();

    expect(await storage.queue.get("prop-old")).toEqual(before);
  });
});

describe("reading a merged-away identity", () => {
  /**
   * Provenance display for a pre-merge event whose target is immutably the old
   * id. The event still says #4891 — nothing rewrote it — and the view resolves
   * it to the survivor.
   */
  it("resolves a merged-away id to the survivor's view", async () => {
    await givenTwoSarahs();
    await whenMerged();

    const { data } = await reads.entityView("per-4891");

    expect(data?.entity.id).toBe("per-4172");
  });

  it("resolves through a chain of any length", async () => {
    await givenTwoSarahs();
    await storage.events.append([anEntityCreated({ aggregateId: "per-5310" })]);
    await worker.catchUp();
    await whenMerged("per-4172", "per-4891");
    await whenMerged("per-5310", "per-4172");

    const { data } = await reads.entityView("per-4891");

    expect(data?.entity.id).toBe("per-5310");
  });

  it("leaves an id nothing merged resolving to itself", async () => {
    await givenTwoSarahs();

    expect((await reads.entityView("per-4891")).data?.entity.id).toBe("per-4891");
  });

  it("reports nothing for an id that never existed", async () => {
    await givenTwoSarahs();

    expect((await reads.entityView("per-nobody")).data).toBeUndefined();
  });
});

describe("the queue still shows a pre-merge entry", () => {
  it("keeps showing what was queued before the merge", async () => {
    await givenTwoSarahs();
    await storage.queue.put([
      anEntry("prop-old", {
        type: SET_FIELD,
        aggregate: { type: "Entity", id: "per-4891", expectedVersion: 1 },
        payload: { field: "employer", value: "Acme" },
        provenance: aProposal().command.provenance,
      }),
    ]);

    await whenMerged();

    expect((await queue.awaitingReview()).data.map((entry) => entry.proposalId)).toEqual([
      "prop-old",
    ]);
  });
});
