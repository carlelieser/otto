import { beforeEach, describe, expect, it } from "vitest";
import { DISCARD_RETENTION_DAYS } from "../../src/domain/policies/retention.js";
import { createStorage, type Storage } from "../../src/composition-root.js";
import type { DispositionRecord } from "../../src/ports/disposition-store.js";

/**
 * `qa.md` §5.7 and `triage.md` §7: discards are recorded, not deleted; shown
 * collapsed, default hidden, retained thirty days.
 *
 * Against SQLite in `:memory:`, which is the offline mode of the one adapter
 * (`add.md` §9) rather than a stand-in for it.
 */

const DECIDED_AT = "2026-08-01T09:00:00.000Z";

let storage: Storage;

beforeEach(() => {
  storage = createStorage();
  return () => storage.close();
});

/** A discarded Proposal, defaulting to the low band it came from. */
function aRecord(overrides: Partial<DispositionRecord> = {}): DispositionRecord {
  return {
    proposalId: "prop-1",
    captureId: "cap-1",
    disposition: "discard",
    confidence: 0.3,
    wasSampled: false,
    decidedAt: DECIDED_AT,
    ...overrides,
  };
}

/** `days` after the decision, as an ISO instant. */
function daysAfterDecision(days: number): string {
  return new Date(Date.parse(DECIDED_AT) + days * 24 * 60 * 60 * 1000).toISOString();
}

describe("recording what triage decided", () => {
  it("keeps a discard rather than dropping it", async () => {
    await storage.dispositions.put([aRecord()]);

    const stored = await storage.dispositions.forCapture("cap-1");

    expect(stored.map((record) => record.disposition)).toEqual(["discard"]);
  });

  /**
   * `qa.md` §5.7: a discarded proposal is retrievable and names its originating
   * Capture. Without the Capture, "why didn't Otto pick that up?" has no answer
   * a user can act on, since re-capturing is the only affordance they get.
   */
  it("names the Capture a discard came from", async () => {
    await storage.dispositions.put([aRecord({ captureId: "cap-monday-standup" })]);

    const [discard] = await storage.dispositions.discards(DECIDED_AT);

    expect(discard?.captureId).toBe("cap-monday-standup");
  });

  it("returns every field it was given", async () => {
    const record = aRecord({ disposition: "needs_review", confidence: 0.72, wasSampled: true });

    await storage.dispositions.put([record]);

    expect(await storage.dispositions.forCapture("cap-1")).toEqual([record]);
  });

  /** The same no-op-on-repeat the other stores have, so no caller learns which is which. */
  it("re-records the same proposal as a no-op", async () => {
    await storage.dispositions.put([aRecord()]);
    await storage.dispositions.put([aRecord()]);

    expect(await storage.dispositions.forCapture("cap-1")).toHaveLength(1);
  });

  it("lists only discards among the dispositions", async () => {
    await storage.dispositions.put([
      aRecord({ proposalId: "prop-1", disposition: "discard" }),
      aRecord({ proposalId: "prop-2", disposition: "needs_review" }),
      aRecord({ proposalId: "prop-3", disposition: "auto_apply" }),
    ]);

    const discards = await storage.dispositions.discards(DECIDED_AT);

    expect(discards.map((record) => record.proposalId)).toEqual(["prop-1"]);
  });
});

/** `qa.md` §5.7 asks for both sides of the boundary: present at 29, absent after 30. */
describe("thirty-day retention", () => {
  it("still holds a discard at 29 days", async () => {
    await storage.dispositions.put([aRecord()]);

    const discards = await storage.dispositions.discards(daysAfterDecision(29));

    expect(discards).toHaveLength(1);
  });

  it("drops a discard past 30 days", async () => {
    await storage.dispositions.put([aRecord()]);

    const discards = await storage.dispositions.discards(daysAfterDecision(31));

    expect(discards).toEqual([]);
  });

  it("retains for exactly the documented window", () => {
    expect(DISCARD_RETENTION_DAYS).toBe(30);
  });

  /**
   * Expiry hides a discard from the surface and purging removes the row. They
   * are separate so a read never has a write behind it — the query is what the
   * UI calls, and a list view is not a thing that should delete.
   */
  it("purges only what has already expired", async () => {
    await storage.dispositions.put([
      aRecord({ proposalId: "prop-old", decidedAt: DECIDED_AT }),
      aRecord({ proposalId: "prop-new", decidedAt: daysAfterDecision(20) }),
    ]);

    const purged = await storage.dispositions.purgeExpiredDiscards(daysAfterDecision(31));

    expect(purged).toBe(1);
    expect((await storage.dispositions.forCapture("cap-1")).map((r) => r.proposalId)).toEqual([
      "prop-new",
    ]);
  });

  /** A review or an auto-apply is not on a thirty-day clock. Only the low band is. */
  it("never purges a non-discard however old", async () => {
    await storage.dispositions.put([aRecord({ disposition: "needs_review" })]);

    const purged = await storage.dispositions.purgeExpiredDiscards(daysAfterDecision(3650));

    expect(purged).toBe(0);
    expect(await storage.dispositions.forCapture("cap-1")).toHaveLength(1);
  });
});

/**
 * `qa.md` §5.7: no affordance exists to act on a discard beyond re-capturing.
 * Making discards actionable would turn the low band into a second review
 * queue, which is what the threshold exists to prevent.
 */
describe("the discard surface exposes no apply path", () => {
  it("offers no method that applies or re-queues a discard", () => {
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(storage.dispositions) as object,
    );

    expect(methods.filter((name) => /apply|requeue|reQueue|promote|restore/i.test(name))).toEqual(
      [],
    );
  });
});
