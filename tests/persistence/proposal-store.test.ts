import { beforeEach, describe, expect, it } from "vitest";
import { createStorage, type Storage } from "../../src/composition-root.js";
import type { ResolvedDate } from "../../src/domain/values/resolved-date.js";
import type { ExtractedProposal } from "../../src/ports/proposal-store.js";
import { A_CAPTURE_ID } from "../support/builders.js";

/**
 * The store extraction's output is recorded in, so the next stage can resume
 * from it rather than re-invoking the model.
 *
 * Real SQLite in `:memory:` — a storage port's offline mode is the real adapter
 * with no disk (`add.md` §9).
 */

function aProposal(overrides: Partial<ExtractedProposal> = {}): ExtractedProposal {
  return {
    proposalId: "prop-aaaa1111",
    captureId: A_CAPTURE_ID,
    mention: {
      text: "Sarah",
      entityType: "Person",
      fields: [{ field: "employer", value: "Globex" }],
      confidence: 0.9,
    },
    provider: "local",
    modelVersion: "qwen2.5-7b-instruct",
    extractedAt: "2026-08-01T09:00:02.000Z",
    ...overrides,
  };
}

describe("the proposal store", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createStorage();
    return () => storage.close();
  });

  it("returns what it stored", async () => {
    const stored = await storage.proposals.put([aProposal()]);

    expect(stored).toEqual([aProposal()]);
  });

  it("round-trips a Mention's field values through JSON", async () => {
    await storage.proposals.put([aProposal()]);

    const [read] = await storage.proposals.forCapture(A_CAPTURE_ID);
    expect(read!.mention.fields).toEqual([{ field: "employer", value: "Globex" }]);
  });

  /** A resolved date is an object, so it is the value most likely to be flattened. */
  it("round-trips a resolved date", async () => {
    const date = {
      timestamp: "2026-08-11T00:00:00.000Z",
      precision: "day",
      phrase: "next Tuesday",
    } satisfies ResolvedDate;
    await storage.proposals.put([
      aProposal({
        mention: {
          text: "Ship the beta",
          entityType: "Task",
          fields: [{ field: "due", value: date }],
          confidence: 0.8,
        },
      }),
    ]);

    const [read] = await storage.proposals.forCapture(A_CAPTURE_ID);
    expect(read!.mention.fields[0]!.value).toEqual(date);
  });

  it("returns a Capture's Proposals in the order they were emitted", async () => {
    await storage.proposals.put([
      aProposal({ proposalId: "prop-first", mention: mentionNamed("Sarah") }),
      aProposal({ proposalId: "prop-second", mention: mentionNamed("Helios") }),
    ]);

    const read = await storage.proposals.forCapture(A_CAPTURE_ID);
    expect(read.map(({ mention }) => mention.text)).toEqual(["Sarah", "Helios"]);
  });

  it("returns nothing for a Capture that has not been extracted", async () => {
    expect(await storage.proposals.forCapture("cap-never-extracted")).toEqual([]);
  });

  describe("idempotency", () => {
    /**
     * A retry under the same model produces the same ids and must produce one
     * Proposal rather than two (`runtime.md` §3). This port no-ops on a repeat
     * insert, matching `EventStore.append` and `CaptureStore.put` — a storage
     * port that throws where its siblings no-op means every caller has to learn
     * which is which.
     */
    it("collapses a re-recorded Proposal into one row", async () => {
      await storage.proposals.put([aProposal()]);
      await storage.proposals.put([aProposal()]);

      expect(await storage.proposals.forCapture(A_CAPTURE_ID)).toHaveLength(1);
    });

    it("keeps the first recording rather than overwriting it", async () => {
      await storage.proposals.put([aProposal({ mention: mentionNamed("Sarah") })]);
      await storage.proposals.put([aProposal({ mention: mentionNamed("Overwritten") })]);

      const [read] = await storage.proposals.forCapture(A_CAPTURE_ID);
      expect(read!.mention.text).toBe("Sarah");
    });

    /**
     * A re-run under a *different* model produces different ids and therefore
     * new Proposals — the half of `runtime.md` §3 that makes re-extraction
     * possible at all.
     */
    it("keeps Proposals from a different model alongside the originals", async () => {
      await storage.proposals.put([aProposal()]);
      await storage.proposals.put([
        aProposal({ proposalId: "prop-better-model", modelVersion: "qwen3-14b-instruct" }),
      ]);

      expect(await storage.proposals.forCapture(A_CAPTURE_ID)).toHaveLength(2);
    });
  });

  it("stores nothing for an extraction that found nothing", async () => {
    expect(await storage.proposals.put([])).toEqual([]);
  });
});

function mentionNamed(text: string) {
  return { text, entityType: "Person" as const, fields: [], confidence: 0.9 };
}
