import { beforeEach, describe, expect, it } from "vitest";
import type { Correction } from "../../src/domain/knowledge/correction.js";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteCorrectionStore } from "../../src/infrastructure/persistence/sqlite-correction-store.js";
import type { CorrectionStore, RecordedCorrection } from "../../src/ports/correction-store.js";
import { A_MODEL, aCommand } from "../support/triage-builders.js";

let corrections: CorrectionStore;

beforeEach(() => {
  corrections = new SqliteCorrectionStore(openDatabase());
});

function aCorrection(overrides: Partial<Correction> = {}): Correction {
  return {
    correctionId: "corr-1",
    proposalId: "prop-1",
    captureId: "cap-1",
    chosen: aCommand(),
    correctedAt: "2026-08-02T09:00:00.000Z",
    ...overrides,
  };
}

function recorded(overrides: Partial<Correction> = {}): RecordedCorrection {
  return { correction: aCorrection(overrides), model: A_MODEL };
}

describe("recording what the user chose instead", () => {
  it("round-trips the chosen Command whole", async () => {
    const chosen = aCommand({ payload: { field: "employer", value: "Globex" } });

    await corrections.put([{ correction: aCorrection({ chosen }), model: A_MODEL }]);

    const [stored] = await corrections.forProposal("prop-1");
    expect(stored?.chosen.payload).toEqual({ field: "employer", value: "Globex" });
  });

  it("is a no-op when the same correction is recorded twice", async () => {
    await corrections.put([recorded()]);
    await corrections.put([recorded()]);

    expect(await corrections.all()).toHaveLength(1);
  });

  it("records nothing for an empty batch", async () => {
    expect(await corrections.put([])).toEqual([]);
    expect(await corrections.all()).toEqual([]);
  });

  /**
   * A user who corrects, thinks again, and corrects to something else has said
   * two things. Both are data, and the second is the one they meant.
   */
  it("keeps a second, different correction of the same Proposal", async () => {
    await corrections.put([recorded()]);
    await corrections.put([
      recorded({
        correctionId: "corr-2",
        chosen: aCommand({ payload: { field: "employer", value: "Globex" } }),
      }),
    ]);

    expect(await corrections.forProposal("prop-1")).toHaveLength(2);
  });
});

/**
 * The bootstrap counter (`triage.md` §4, ADR-0008). Per provider *and* model
 * version, because a threshold measured against one model says nothing about
 * another.
 */
describe("counting corrections for a model", () => {
  beforeEach(async () => {
    await corrections.put([
      recorded({ correctionId: "corr-1" }),
      recorded({ correctionId: "corr-2" }),
    ]);
  });

  it("counts the corrections for that provider and model version", async () => {
    expect(await corrections.countForModel(A_MODEL.provider, A_MODEL.modelVersion)).toBe(2);
  });

  it("does not count another model's corrections", async () => {
    await corrections.put([
      {
        correction: aCorrection({ correctionId: "corr-3" }),
        model: { ...A_MODEL, modelVersion: "qwen3-8b" },
      },
    ]);

    expect(await corrections.countForModel(A_MODEL.provider, A_MODEL.modelVersion)).toBe(2);
    expect(await corrections.countForModel(A_MODEL.provider, "qwen3-8b")).toBe(1);
  });

  it("does not count another provider's corrections", async () => {
    await corrections.put([
      {
        correction: aCorrection({ correctionId: "corr-4" }),
        model: { ...A_MODEL, provider: "anthropic" },
      },
    ]);

    expect(await corrections.countForModel(A_MODEL.provider, A_MODEL.modelVersion)).toBe(2);
    expect(await corrections.countForModel("anthropic", A_MODEL.modelVersion)).toBe(1);
  });

  it("is zero for a model nothing has been corrected under", async () => {
    expect(await corrections.countForModel("anthropic", "claude-opus-5")).toBe(0);
  });
});

describe("reading the corpus", () => {
  it("returns every correction newest first", async () => {
    await corrections.put([
      recorded({ correctionId: "corr-1", correctedAt: "2026-08-01T09:00:00.000Z" }),
      recorded({ correctionId: "corr-2", correctedAt: "2026-08-02T09:00:00.000Z" }),
    ]);

    expect((await corrections.all()).map((one) => one.correctionId)).toEqual(["corr-2", "corr-1"]);
  });

  it("returns one Proposal's corrections oldest first", async () => {
    await corrections.put([
      recorded({ correctionId: "corr-2", correctedAt: "2026-08-02T09:00:00.000Z" }),
      recorded({ correctionId: "corr-1", correctedAt: "2026-08-01T09:00:00.000Z" }),
    ]);

    expect((await corrections.forProposal("prop-1")).map((one) => one.correctionId)).toEqual([
      "corr-1",
      "corr-2",
    ]);
  });

  it("returns nothing for a Proposal never corrected", async () => {
    expect(await corrections.forProposal("prop-nothing")).toEqual([]);
  });
});
