import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteReviewQueueStore } from "../../src/infrastructure/persistence/sqlite-review-queue-store.js";
import type { QueuedProposal, ReviewQueueStore } from "../../src/ports/review-queue-store.js";
import { aProposal } from "../support/triage-builders.js";

let queue: ReviewQueueStore;

beforeEach(() => {
  queue = new SqliteReviewQueueStore(openDatabase());
});

function anEntry(overrides: Partial<QueuedProposal> = {}): QueuedProposal {
  return {
    proposal: aProposal(),
    disposition: "needs_review",
    confidence: 0.72,
    wasSampled: false,
    adjudicatedAt: null,
    queuedAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("recording triaged Proposals", () => {
  it("round-trips the Proposal whole, Command included", async () => {
    const entry = anEntry();

    await queue.put([entry]);

    expect(await queue.get(entry.proposal.proposalId)).toEqual(entry);
  });

  /** The Command is what adjudication hands the executor, so it must survive. */
  it("preserves the expected version the Command was computed against", async () => {
    const aggregate = { type: "Entity", id: "per-x", expectedVersion: 7 };
    const proposal = aProposal({ command: { ...aProposal().command, aggregate } });

    await queue.put([anEntry({ proposal })]);

    const stored = await queue.get(proposal.proposalId);
    expect(stored?.proposal.command.aggregate).toEqual(aggregate);
  });

  /** Matching every other store here: a retried write is a no-op, not a duplicate. */
  it("is a no-op when the same Proposal is recorded twice", async () => {
    await queue.put([anEntry()]);
    await queue.put([anEntry({ confidence: 0.99 })]);

    const all = await queue.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.confidence).toBe(0.72);
  });

  it("records nothing and returns empty for an empty batch", async () => {
    expect(await queue.put([])).toEqual([]);
    expect(await queue.list()).toEqual([]);
  });
});

describe("listing the queue", () => {
  beforeEach(async () => {
    await queue.put([
      anEntry({
        proposal: aProposal({ proposalId: "prop-review" }),
        disposition: "needs_review",
        queuedAt: "2026-08-01T09:00:00.000Z",
      }),
      anEntry({
        proposal: aProposal({ proposalId: "prop-applied" }),
        disposition: "auto_apply",
        queuedAt: "2026-08-01T10:00:00.000Z",
      }),
    ]);
  });

  it("returns everything newest first", async () => {
    const all = await queue.list();

    expect(all.map((entry) => entry.proposal.proposalId)).toEqual(["prop-applied", "prop-review"]);
  });

  /** PRD §5.4: the two lists are the same shape, so one query narrows to either. */
  it("narrows to one disposition", async () => {
    const waiting = await queue.list({ disposition: "needs_review" });

    expect(waiting.map((entry) => entry.proposal.proposalId)).toEqual(["prop-review"]);
  });

  it("narrows to what no human has answered", async () => {
    await queue.markAdjudicated("prop-review", "2026-08-02T09:00:00.000Z");

    const waiting = await queue.list({ awaitingAdjudication: true });

    expect(waiting.map((entry) => entry.proposal.proposalId)).toEqual(["prop-applied"]);
  });

  it("returns undefined for a Proposal it does not hold", async () => {
    expect(await queue.get("prop-nothing")).toBeUndefined();
  });
});

describe("adjudicating an entry", () => {
  /**
   * PRD §5.4 wants what Otto did to stay visible. A confirmed entry leaves the
   * *waiting* list and stays readable, which is a different thing from being
   * deleted.
   */
  it("stamps the entry rather than removing it", async () => {
    await queue.put([anEntry()]);

    await queue.markAdjudicated(aProposal().proposalId, "2026-08-02T09:00:00.000Z");

    const stored = await queue.get(aProposal().proposalId);
    expect(stored?.adjudicatedAt).toBe("2026-08-02T09:00:00.000Z");
    expect(stored?.disposition).toBe("needs_review");
  });

  it("is silent about a Proposal it does not hold", async () => {
    await expect(
      queue.markAdjudicated("prop-nothing", "2026-08-02T09:00:00.000Z"),
    ).resolves.toBeUndefined();
  });
});

/**
 * ADR-0006's half that must survive storage. Calibration reads this later, so a
 * store that dropped it would make the sampled population unfindable — and
 * ADR-0006 is explicit that it cannot be reconstructed retroactively.
 */
describe("the sampling mark", () => {
  it("survives the round trip", async () => {
    await queue.put([anEntry({ wasSampled: true })]);

    expect((await queue.get(aProposal().proposalId))?.wasSampled).toBe(true);
  });

  it("is stored per entry rather than assumed", async () => {
    await queue.put([
      anEntry({ proposal: aProposal({ proposalId: "prop-a" }), wasSampled: true }),
      anEntry({ proposal: aProposal({ proposalId: "prop-b" }), wasSampled: false }),
    ]);

    expect((await queue.get("prop-a"))?.wasSampled).toBe(true);
    expect((await queue.get("prop-b"))?.wasSampled).toBe(false);
  });
});
