import { describe, expect, it } from "vitest";
import {
  DUPLICATE_FLOOR,
  suspectedDuplicates,
} from "../../src/inference/duplicates/detect-duplicates.js";
import { anEntity } from "../support/knowledge-builders.js";

/**
 * **Duplicate detection as a projection** (`triage.md` §5, `qa.md` §7.4).
 *
 * Candidate generation pointed at the entity table instead of at a Mention, so
 * it reuses Slice 4's machinery rather than inventing a second notion of what
 * makes two things alike. What it produces is a suspected pair for the review
 * queue — never a merge, because merge waits for the user at any confidence.
 */

/** Two Sarahs a transcription error apart, which is the case this exists for. */
const SARAH = anEntity({ id: "per-4172", fields: { name: ["Sarah Chen"] } });
const SARA = anEntity({ id: "per-4891", fields: { name: ["Sara Chen"] } });

describe("finding suspected duplicates", () => {
  it("pairs two entities whose names are a near miss", () => {
    const pairs = suspectedDuplicates([SARAH, SARA]);

    expect(pairs).toHaveLength(1);
    expect([pairs[0]?.survivorId, pairs[0]?.mergedId].sort()).toEqual(["per-4172", "per-4891"]);
  });

  it("leaves unrelated names alone", () => {
    const pairs = suspectedDuplicates([
      SARAH,
      anEntity({ id: "per-2", fields: { name: ["Tom Wu"] } }),
    ]);

    expect(pairs).toEqual([]);
  });

  /**
   * Two Sarahs of different types are two things that share a name, which is
   * what a Person named "Helios" and a Project named "Helios" in fact are.
   */
  it("never pairs entities of different types", () => {
    const project = anEntity({ id: "proj-1", type: "Project", fields: { name: ["Sarah Chen"] } });

    expect(suspectedDuplicates([SARAH, project])).toEqual([]);
  });

  it("reports each pair once rather than in both directions", () => {
    const pairs = suspectedDuplicates([
      SARAH,
      SARA,
      anEntity({ id: "per-3", fields: { name: ["Sarah Chen"] } }),
    ]);

    const keys = pairs.map((pair) => [pair.survivorId, pair.mergedId].sort().join("|"));
    expect(new Set(keys).size).toBe(keys.length);
  });

  /** An alias match is the highest-precision signal candidate generation has. */
  it("pairs entities that share an alias", () => {
    const known = anEntity({ id: "per-1", fields: { name: ["Sarah Chen"], aliases: ["SC"] } });
    const other = anEntity({ id: "per-2", fields: { name: ["Tom Wu"], aliases: ["SC"] } });

    expect(suspectedDuplicates([known, other])).toHaveLength(1);
  });

  /**
   * The **older** id survives, so a pair proposed twice proposes the same merge
   * both times. Direction decided by anything unstable would make one pair two
   * different queue entries the user has to answer separately.
   */
  it("proposes the same direction however the entities are ordered", () => {
    const [forward] = suspectedDuplicates([SARAH, SARA]);
    const [reversed] = suspectedDuplicates([SARA, SARAH]);

    expect(reversed).toEqual(forward);
  });

  it("reports how alike the pair is, so the entry can be ordered", () => {
    const [pair] = suspectedDuplicates([SARAH, SARA]);

    expect(pair?.similarity).toBeGreaterThanOrEqual(DUPLICATE_FLOOR);
    expect(pair?.similarity).toBeLessThan(1);
  });

  it("finds nothing in an entity table of one", () => {
    expect(suspectedDuplicates([SARAH])).toEqual([]);
  });

  /**
   * A merged-away entity is gone from the projection this reads, so no pair can
   * name one. Detecting the same pair forever after the user merged it is the
   * failure that would make the queue unusable.
   */
  it("cannot pair an entity the table no longer holds", () => {
    const pairs = suspectedDuplicates([SARAH]);

    expect(pairs.some((pair) => pair.mergedId === "per-4891")).toBe(false);
  });
});
