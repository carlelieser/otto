import { beforeEach, describe, expect, it } from "vitest";
import { ProposalAdjudication } from "../../src/application/pipeline/adjudicate-proposal.js";
import { BootstrapStatus } from "../../src/application/surface/read-bootstrap-status.js";
import {
  createAdjudication,
  createCorrectionCounts,
  createStorage,
  type Storage,
} from "../../src/composition-root.js";
import { BOOTSTRAP_CORRECTIONS } from "../../src/inference/calibration/bootstrap.js";
import { SET_FIELD } from "../../src/domain/commands/knowledge-commands.js";
import type { QueuedProposal } from "../../src/ports/review-queue-store.js";
import { A_MODEL, aCommand, aProposal } from "../support/triage-builders.js";

/**
 * `triage.md` §4 and `qa.md` §5.4: bootstrap status is **visible, not silent**.
 * A user wondering why Otto is asking so many questions deserves the answer
 * that it is still learning what its own confidence is worth.
 */

let storage: Storage;
let status: BootstrapStatus;
let adjudication: ProposalAdjudication;

beforeEach(() => {
  storage = createStorage();
  status = new BootstrapStatus(storage.corrections);
  adjudication = createAdjudication(storage, () => "2026-08-02T09:00:00.000Z");
  return () => storage.close();
});

/** Records `count` distinct corrections under `model`, without going through the executor. */
async function accumulate(count: number, model = A_MODEL): Promise<void> {
  await storage.corrections.put(
    Array.from({ length: count }, (_, index) => ({
      correction: {
        correctionId: `corr-${model.provider}-${model.modelVersion}-${index}`,
        proposalId: `prop-${index}`,
        captureId: "cap-1",
        chosen: aCommand(),
        correctedAt: "2026-08-02T09:00:00.000Z",
      },
      model,
    })),
  );
}

describe("what the dashboard is told", () => {
  it("says Otto is bootstrapping when nothing has been corrected", async () => {
    const report = await status.forModel(A_MODEL);

    expect(report.isBootstrapping).toBe(true);
    expect(report.correctionCount).toBe(0);
  });

  /**
   * PRD §5.4: friction without explanation reads as the product being bad at
   * its job, so the surface says how far along it is rather than only that it
   * is holding back.
   */
  it("says how many corrections remain", async () => {
    await accumulate(20);

    const report = await status.forModel(A_MODEL);

    expect(report.correctionCount).toBe(20);
    expect(report.remaining).toBe(BOOTSTRAP_CORRECTIONS - 20);
  });

  it("names the model it is reporting on", async () => {
    const report = await status.forModel(A_MODEL);

    expect(report.model).toEqual(A_MODEL);
  });

  it("reports nothing remaining once bootstrap is over", async () => {
    await accumulate(BOOTSTRAP_CORRECTIONS);

    expect((await status.forModel(A_MODEL)).remaining).toBe(0);
  });
});

/** `qa.md` §5.4: the 50th correction exits bootstrap; the 49th does not. */
describe("exiting bootstrap", () => {
  it("is still bootstrapping at 49 corrections", async () => {
    await accumulate(BOOTSTRAP_CORRECTIONS - 1);

    expect((await status.forModel(A_MODEL)).isBootstrapping).toBe(true);
  });

  it("has exited at 50", async () => {
    await accumulate(BOOTSTRAP_CORRECTIONS);

    expect((await status.forModel(A_MODEL)).isBootstrapping).toBe(false);
  });

  /**
   * Per provider and model version (ADR-0008). Switching models re-enters
   * bootstrap even with fifty corrections behind the old one, which is correct
   * rather than an inconvenience: a threshold measured against one model says
   * nothing about another.
   */
  it("re-enters bootstrap when the model version changes", async () => {
    await accumulate(BOOTSTRAP_CORRECTIONS);

    const upgraded = { ...A_MODEL, modelVersion: "qwen3-8b-instruct" };

    expect((await status.forModel(A_MODEL)).isBootstrapping).toBe(false);
    expect((await status.forModel(upgraded)).isBootstrapping).toBe(true);
  });

  it("re-enters bootstrap when the provider changes", async () => {
    await accumulate(BOOTSTRAP_CORRECTIONS);

    const cloud = { ...A_MODEL, provider: "anthropic" };

    expect((await status.forModel(cloud)).isBootstrapping).toBe(true);
  });
});

/**
 * The slice's Done-when: accumulating 50 corrections for a model exits
 * bootstrap for that model. Asserted through the counter triage actually reads,
 * rather than against the store directly.
 */
describe("the counter triage reads", () => {
  it("reflects corrections made through the queue", async () => {
    const entry: QueuedProposal = {
      proposal: aProposal(),
      disposition: "needs_review",
      confidence: 0.7,
      wasSampled: false,
      adjudicatedAt: null,
      queuedAt: "2026-08-01T09:00:00.000Z",
    };
    await storage.queue.put([entry]);

    await adjudication.correct(
      aProposal().proposalId,
      aCommand({ type: SET_FIELD, payload: { field: "employer", value: "Acme" } }),
    );

    const counts = createCorrectionCounts(storage);
    expect(await counts.forModel(A_MODEL.provider, A_MODEL.modelVersion)).toBe(1);
  });

  it("is zero for a model nothing has been corrected under", async () => {
    const counts = createCorrectionCounts(storage);

    expect(await counts.forModel("anthropic", "claude-opus-5")).toBe(0);
  });
});
