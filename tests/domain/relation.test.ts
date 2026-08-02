import { describe, expect, it } from "vitest";
import { relationInstanceViolations } from "../../src/domain/knowledge/relation.js";
import {
  CATCH_ALL_RELATION,
  relationMix,
} from "../../src/inference/resolution/relation-metrics.js";
import { RELATION_NAMES } from "../../src/domain/schema/relation-schema.js";

describe("a stored relation", () => {
  it("accepts an edge whose ends match a declared type pair", () => {
    const violations = relationInstanceViolations({
      name: "involves",
      from: { id: "proj-1", type: "Project" },
      to: { id: "per-1", type: "Person" },
    });

    expect(violations).toEqual([]);
  });

  it("refuses an edge whose ends do not match a declared type pair", () => {
    const violations = relationInstanceViolations({
      name: "knows",
      from: { id: "per-1", type: "Person" },
      to: { id: "proj-1", type: "Project" },
    });

    expect(violations).not.toEqual([]);
  });

  /**
   * A type pair cannot see this one: `blocks` from a Task to a Task is a legal
   * pair, and the same Task on both ends is not a dependency.
   */
  it("refuses an entity related to itself", () => {
    const violations = relationInstanceViolations({
      name: "blocks",
      from: { id: "task-1", type: "Task" },
      to: { id: "task-1", type: "Task" },
    });

    expect(violations).not.toEqual([]);
  });

  it("accepts two distinct entities of the same type", () => {
    const violations = relationInstanceViolations({
      name: "blocks",
      from: { id: "task-1", type: "Task" },
      to: { id: "task-2", type: "Task" },
    });

    expect(violations).toEqual([]);
  });
});

/**
 * Monitoring rather than assertion (`qa.md` §7.3). These test that the number
 * is computed correctly, never that it sits below some bar — a bar here would
 * fail as the knowledge base grows, which teaches everyone to delete the test.
 */
describe("the relation mix", () => {
  it("reports the catch-all's share of the graph", () => {
    const mix = relationMix(["relates_to", "relates_to", "involves", "knows"]);

    expect(mix.catchAllShare).toBe(0.5);
    expect(mix.total).toBe(4);
  });

  it("counts every relation name, including the ones absent from the graph", () => {
    const mix = relationMix(["involves"]);

    expect(Object.keys(mix.counts).sort()).toEqual([...RELATION_NAMES].sort());
    expect(mix.counts.knows).toBe(0);
    expect(mix.counts.involves).toBe(1);
  });

  it("reports a zero share for an empty graph rather than dividing by zero", () => {
    const mix = relationMix([]);

    expect(mix.catchAllShare).toBe(0);
    expect(Number.isNaN(mix.catchAllShare)).toBe(false);
  });

  it("names `relates_to` as the catch-all §6 says to watch", () => {
    expect(CATCH_ALL_RELATION).toBe("relates_to");
  });
});
