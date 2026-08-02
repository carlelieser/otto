import { beforeEach, describe, expect, it } from "vitest";
import {
  CaptureTriage,
  type CorrectionCounts,
} from "../../src/application/pipeline/triage-capture.js";
import { ReviewQueue } from "../../src/application/surface/read-review-queue.js";
import { createExecutor, createStorage, type Storage } from "../../src/composition-root.js";
import { aProposal } from "../support/triage-builders.js";

/**
 * The queue as a surface: what triage put in it, and what the user may do with
 * each kind of entry (PRD §5.4, `triage.md` §7).
 */

const DECIDED_AT = "2026-08-01T09:00:00.000Z";
const NEVER_SAMPLED = () => 1;
const NO_CORRECTIONS: CorrectionCounts = { forModel: async () => 0 };

let storage: Storage;
let queue: ReviewQueue;

function createTriage(draw = NEVER_SAMPLED, corrections = NO_CORRECTIONS): CaptureTriage {
  return new CaptureTriage({
    executor: createExecutor(storage.events, () => DECIDED_AT),
    dispositions: storage.dispositions,
    queue: storage.queue,
    corrections,
    now: () => DECIDED_AT,
    draw,
  });
}

beforeEach(() => {
  storage = createStorage();
  queue = new ReviewQueue(storage.queue, storage.dispositions, storage.projections);
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

/** A middling proposal, which lands in review. */
function aReviewable(overrides = {}) {
  return aProposal({
    proposalId: "prop-review",
    confidences: { extraction: 0.7, resolution: 0.8 },
    resolution: { outcome: "matched", wasAdjudicated: false, candidateCount: 2 },
    ...overrides,
  });
}

describe("what triage puts in the queue", () => {
  it("shows a proposal awaiting judgement", async () => {
    await createTriage().triageAll([aReviewable()]);

    const { data } = await queue.awaitingReview();

    expect(data.map((entry) => entry.proposalId)).toEqual(["prop-review"]);
  });

  /**
   * PRD §5.4: confident non-destructive changes apply automatically and appear
   * **as a record rather than a request**, so they stay visible and correctable
   * rather than silent.
   */
  it("shows an auto-applied change as a record", async () => {
    await createTriage().triageAll([aConfidentCreate()]);

    const { data } = await queue.appliedRecords();

    expect(data.map((entry) => entry.proposalId)).toEqual(["prop-1"]);
    expect(data[0]?.isRecord).toBe(true);
  });

  it("keeps requests and records apart", async () => {
    await createTriage().triageAll([aConfidentCreate(), aReviewable()]);

    const awaiting = await queue.awaitingReview();
    const records = await queue.appliedRecords();

    expect(awaiting.data.map((entry) => entry.proposalId)).toEqual(["prop-review"]);
    expect(records.data.map((entry) => entry.proposalId)).toEqual(["prop-1"]);
  });

  /** A discard is recorded but never queued: the low band is not a second queue. */
  it("does not put a discard in either list", async () => {
    const discarded = aProposal({
      proposalId: "prop-low",
      confidences: { extraction: 0.2, resolution: 0.3 },
    });

    await createTriage().triageAll([discarded]);

    expect((await queue.awaitingReview()).data).toEqual([]);
    expect((await queue.appliedRecords()).data).toEqual([]);
  });

  it("states what would change, so the entry reads as a decision", async () => {
    await createTriage().triageAll([aReviewable()]);

    const [entry] = (await queue.awaitingReview()).data;

    expect(entry?.command.type).toBeDefined();
    expect(entry?.entityType).toBe("Person");
    expect(entry?.captureId).toBe("cap-1");
  });
});

/**
 * **Both halves of ADR-0006's sampling requirement** (`qa.md` §5.5).
 *
 * The mark exists in the data for calibration, and must not reach the UI — a
 * user who knows they are being measured adjudicates differently, and a
 * measurement that changes what it measures is not one.
 */
describe("a sampled proposal", () => {
  const ALWAYS_SAMPLED = () => 0;

  it("is marked in the data", async () => {
    await createTriage(ALWAYS_SAMPLED).triageAll([aConfidentCreate()]);

    const stored = await storage.queue.get("prop-1");

    expect(stored?.wasSampled).toBe(true);
  });

  /**
   * The negative half, asserted over the entry's own keys rather than by
   * reading a field that should not be there. A `wasSampled` added to the view
   * later would fail this without anyone having to remember why.
   */
  it("is indistinguishable from an ordinary entry in the UI", async () => {
    await createTriage(ALWAYS_SAMPLED).triageAll([aConfidentCreate()]);

    const [sampled] = (await queue.awaitingReview()).data;

    expect(JSON.stringify(sampled)).not.toMatch(/sampl/i);
    expect(Object.keys(sampled ?? {})).not.toContain("wasSampled");
  });

  it("sits in the review list beside ordinary entries", async () => {
    await createTriage(ALWAYS_SAMPLED).triageAll([aConfidentCreate(), aReviewable()]);

    const { data } = await queue.awaitingReview();

    expect(data).toHaveLength(2);
    const shapes = data.map((entry) => Object.keys(entry).sort().join(","));
    expect(new Set(shapes).size).toBe(1);
  });
});

/**
 * `triage.md` §7 and `qa.md` §5.7: discards are retrievable, name their
 * Capture, and there is **no affordance to act on them beyond re-capturing**.
 */
describe("the discard section", () => {
  beforeEach(async () => {
    await createTriage().triageAll([
      aProposal({ proposalId: "prop-low", confidences: { extraction: 0.2, resolution: 0.3 } }),
    ]);
  });

  it("lists what was dropped and names its Capture", async () => {
    const { data } = await queue.discards(DECIDED_AT);

    expect(data).toHaveLength(1);
    expect(data[0]?.captureId).toBe("cap-1");
  });

  it("is present at 29 days", async () => {
    const { data } = await queue.discards("2026-08-30T09:00:00.000Z");

    expect(data).toHaveLength(1);
  });

  it("is absent after 30 days", async () => {
    const { data } = await queue.discards("2026-09-01T09:00:00.000Z");

    expect(data).toEqual([]);
  });

  /**
   * The load-bearing negative. Making discards actionable would turn the low
   * band into a second review queue, which is what the threshold exists to
   * prevent — so a discard entry carries nothing that could be applied.
   */
  it("exposes no way to act on a discard", async () => {
    const [discard] = (await queue.discards(DECIDED_AT)).data;

    expect(Object.keys(discard ?? {})).toEqual(["proposalId", "captureId", "discardedAt"]);
    expect(discard).not.toHaveProperty("command");
  });

  it("offers no apply path on the surface itself", () => {
    const surface = Object.getOwnPropertyNames(ReviewQueue.prototype);

    expect(surface.filter((name) => /apply|confirm|restore|act/i.test(name))).toEqual([]);
  });
});

/** `add.md` §6: every read surface reports how far the projection has folded. */
describe("staleness on the queue surface", () => {
  it("reports the projection's freshness alongside the data", async () => {
    await createTriage().triageAll([aReviewable()]);

    const { freshness } = await queue.awaitingReview();

    expect(freshness.isRebuilding).toBe(false);
    expect(typeof freshness.position).toBe("number");
  });
});
