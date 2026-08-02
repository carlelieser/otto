import { beforeEach, describe, expect, it } from "vitest";
import { DuplicateDetection } from "../../src/application/pipeline/detect-duplicates.js";
import { ReviewQueue } from "../../src/application/surface/read-review-queue.js";
import { createStorage, type Storage } from "../../src/composition-root.js";
import { MERGE_ENTITIES } from "../../src/domain/commands/knowledge-commands.js";
import type { Entity } from "../../src/domain/knowledge/entity.js";

/**
 * **Suspected duplicates reaching the review queue** (`triage.md` §5,
 * `qa.md` §7.4).
 *
 * The detection itself is tested against the pure function in
 * `tests/inference/duplicate-detection.test.ts`. This is about what the stage
 * does with a pair: it becomes an entry the user can confirm, carrying a
 * `MergeEntities` Command, at `needs_review` and never anything else.
 */

const DETECTED_AT = "2026-08-02T09:00:00.000Z";

let storage: Storage;
let queue: ReviewQueue;
let detection: DuplicateDetection;

/** A Person in the projection, written directly so the stage has a table to read. */
function givenEntity(id: string, name: string, type: Entity["type"] = "Person"): void {
  storage.entities.putEntity({ id, type, fields: { name: [name] }, version: 1 });
}

beforeEach(() => {
  storage = createStorage();
  queue = new ReviewQueue(storage.queue, storage.dispositions, storage.projections);
  detection = new DuplicateDetection({
    entities: (type) => storage.views.entitiesOfType(type),
    queue: storage.queue,
    now: () => DETECTED_AT,
  });
  return () => storage.close();
});

describe("surfacing suspected duplicates", () => {
  it("puts a suspected pair in the review queue", async () => {
    givenEntity("per-4172", "Sarah Chen");
    givenEntity("per-4891", "Sara Chen");

    await detection.sweep();

    const { data } = await queue.awaitingReview();
    expect(data).toHaveLength(1);
  });

  it("carries a MergeEntities Command naming both identities", async () => {
    givenEntity("per-4172", "Sarah Chen");
    givenEntity("per-4891", "Sara Chen");

    await detection.sweep();

    const [entry] = (await queue.awaitingReview()).data;
    expect(entry?.command.type).toBe(MERGE_ENTITIES);
    expect(entry?.command.aggregate.id).toBe("per-4172");
    expect(entry?.command.payload).toEqual({ mergedId: "per-4891" });
  });

  /**
   * **Merge never auto-applies, at any confidence** (`triage.md` §3, ADR-0007).
   * The Slice 5 policy row, re-verified against the real merge path rather than
   * against a Proposal built to exercise it.
   */
  it("never applies a merge unattended, however alike the pair", async () => {
    givenEntity("per-4172", "Sarah Chen");
    givenEntity("per-4891", "Sarah Chen");

    await detection.sweep();

    expect((await queue.appliedRecords()).data).toEqual([]);
    expect((await queue.awaitingReview()).data).toHaveLength(1);
  });

  /** An identical pair is 1.0 alike, which is the case a threshold would miss. */
  it("still waits for the user when the two names are identical", async () => {
    givenEntity("per-4172", "Sarah Chen");
    givenEntity("per-4891", "Sarah Chen");

    await detection.sweep();

    const [entry] = (await queue.awaitingReview()).data;
    expect(entry?.isRecord).toBe(false);
  });

  it("finds nothing when no two entities are alike", async () => {
    givenEntity("per-1", "Sarah Chen");
    givenEntity("per-2", "Tom Wu");

    await detection.sweep();

    expect((await queue.awaitingReview()).data).toEqual([]);
  });

  it("sweeps every entity type rather than only People", async () => {
    givenEntity("proj-1", "Helios Rollout", "Project");
    givenEntity("proj-2", "Helios Rollouts", "Project");

    await detection.sweep();

    expect((await queue.awaitingReview()).data).toHaveLength(1);
  });

  /** The entry says what kind of thing the pair is, so the surface can render it. */
  it("carries the pair's own type rather than assuming Person", async () => {
    givenEntity("proj-1", "Helios Rollout", "Project");
    givenEntity("proj-2", "Helios Rollouts", "Project");

    await detection.sweep();

    expect((await queue.awaitingReview()).data[0]?.entityType).toBe("Project");
  });

  /**
   * A sweep repeated over an unchanged table re-proposes the same pair, which
   * must be the same entry rather than a second one — the id is derived from
   * the pair, so a queue the user has not answered does not fill up with copies
   * of one question.
   */
  it("proposes one entry however often it sweeps", async () => {
    givenEntity("per-4172", "Sarah Chen");
    givenEntity("per-4891", "Sara Chen");

    await detection.sweep();
    await detection.sweep();

    expect((await queue.awaitingReview()).data).toHaveLength(1);
  });
});
