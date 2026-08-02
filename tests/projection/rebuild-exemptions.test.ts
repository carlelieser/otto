import { beforeEach, describe, expect, it } from "vitest";
import {
  createAdjudication,
  createProjectionWorker,
  createStorage,
  createTriage,
  type Storage,
} from "../../src/composition-root.js";
import { SET_FIELD } from "../../src/domain/commands/knowledge-commands.js";
import {
  PROJECTION_TABLES,
  REBUILD_EXEMPT_PROJECTIONS,
} from "../../src/infrastructure/persistence/projection-tables.js";
import { A_MODEL, aCommand, aProposal } from "../support/triage-builders.js";

/**
 * **What a rebuild must not destroy.**
 *
 * ADR-0005 makes rebuild routine rather than disaster recovery, which is
 * exactly why this matters: an operation run casually must not take the
 * correction corpus with it. ADR-0006 calls that corpus unreconstructable, and
 * the compensating event cannot restore it — `humanConfirmedProvenance` names
 * no provider and no model version, so a replay could not say which model was
 * corrected even in principle.
 */

const AT = "2026-08-02T09:00:00.000Z";

let storage: Storage;

beforeEach(() => {
  storage = createStorage();
  return () => storage.close();
});

describe("the two exempt tables", () => {
  it("are not in the list a rebuild empties", () => {
    for (const table of REBUILD_EXEMPT_PROJECTIONS) {
      expect(PROJECTION_TABLES).not.toContain(table);
    }
  });

  it("names both of them, so neither is exempt by accident", () => {
    expect([...REBUILD_EXEMPT_PROJECTIONS]).toEqual([
      "projection_queue_entries",
      "projection_corrections",
    ]);
  });
});

describe("a rebuild", () => {
  beforeEach(async () => {
    await createTriage(storage, () => AT).triageAll([
      aProposal({
        confidences: { extraction: 0.7, resolution: 0.8 },
        resolution: { outcome: "matched", wasAdjudicated: false, candidateCount: 2 },
      }),
    ]);
  });

  /** Pending decisions are not Otto's to discard while fixing something else. */
  it("leaves an unanswered queue entry in place", async () => {
    await createProjectionWorker(storage).rebuild();

    expect(await storage.queue.get("prop-1")).toBeDefined();
  });

  it("leaves the correction corpus intact", async () => {
    await createAdjudication(storage, () => AT).correct(
      "prop-1",
      aCommand({ type: SET_FIELD, payload: { field: "employer", value: "Globex" } }),
    );

    await createProjectionWorker(storage).rebuild();

    expect(await storage.corrections.all()).toHaveLength(1);
  });

  /**
   * The consequence that would be silent: a rebuild that emptied the corpus
   * would return every model to bootstrap without anything reporting it.
   */
  it("does not return a model to bootstrap by emptying its count", async () => {
    await createAdjudication(storage, () => AT).correct(
      "prop-1",
      aCommand({ type: SET_FIELD, payload: { field: "employer", value: "Globex" } }),
    );
    const before = await storage.corrections.countForModel(A_MODEL.provider, A_MODEL.modelVersion);

    await createProjectionWorker(storage).rebuild();

    expect(await storage.corrections.countForModel(A_MODEL.provider, A_MODEL.modelVersion)).toBe(
      before,
    );
  });

  /** The entity projection is still rebuilt, so the exemption is narrow. */
  it("still rebuilds the entity projection", async () => {
    await createAdjudication(storage, () => AT).confirm("prop-1");

    await createProjectionWorker(storage).rebuild();

    expect((await storage.views.entityView("per-sarah"))?.entity.id).toBe("per-sarah");
  });
});
