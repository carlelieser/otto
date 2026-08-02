import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RELATE } from "../../src/domain/commands/knowledge-commands.js";
import type { Relation } from "../../src/domain/knowledge/relation.js";
import { diffRelations } from "../../src/inference/differ/diff-relations.js";

const INVOLVES: Relation = {
  name: "involves",
  from: { id: "proj-helios", type: "Project" },
  to: { id: "per-sarah", type: "Person" },
};

describe("diffing relations into Commands", () => {
  it("produces a Relate Command for a claimed edge the graph does not hold", () => {
    const { changes } = diffRelations([INVOLVES], []);

    expect(changes).toEqual([
      {
        type: RELATE,
        payload: {
          relation: "involves",
          fromId: "proj-helios",
          fromType: "Project",
          toId: "per-sarah",
          toType: "Person",
        },
      },
    ]);
  });

  /** The same no-op rule the field differ follows. */
  it("produces no Command for an edge the graph already holds", () => {
    expect(diffRelations([INVOLVES], [INVOLVES]).changes).toEqual([]);
  });

  it("produces no Command for no claimed relations", () => {
    expect(diffRelations([], [INVOLVES]).changes).toEqual([]);
  });

  it("produces a Command for a second target of a set relation", () => {
    const other = { ...INVOLVES, to: { id: "per-marco", type: "Person" as const } };

    const { changes } = diffRelations([other], [INVOLVES]);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.payload.toId).toBe("per-marco");
  });

  /**
   * `became` is `single` (`schema.md` §6), so an Idea that became a different
   * thing is a supersession rather than a no-op. The Command names the new
   * target; superseding is the executor's job, as it is for a `single` field.
   */
  it("produces a Command when a single relation points somewhere new", () => {
    const became: Relation = {
      name: "became",
      from: { id: "idea-1", type: "Idea" },
      to: { id: "proj-1", type: "Project" },
    };
    const now = { ...became, to: { id: "task-1", type: "Task" as const } };

    const { changes } = diffRelations([now], [became]);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.payload.toId).toBe("task-1");
  });

  it("keeps direction meaningful: the reverse edge is a different claim", () => {
    const reversed: Relation = {
      name: "blocks",
      from: { id: "task-2", type: "Task" },
      to: { id: "task-1", type: "Task" },
    };
    const forward: Relation = { ...reversed, from: reversed.to, to: reversed.from };

    expect(diffRelations([reversed], [forward]).changes).toHaveLength(1);
  });
});

describe("the closed vocabulary at the differ", () => {
  /** §6's own example: a `knows` between a Person and a Project is refused. */
  it("refuses an edge whose ends do not match a declared type pair", () => {
    const wrong: Relation = {
      name: "knows",
      from: { id: "per-sarah", type: "Person" },
      to: { id: "proj-helios", type: "Project" },
    };

    const { changes, refused } = diffRelations([wrong], []);

    expect(changes).toEqual([]);
    expect(refused).toHaveLength(1);
  });

  it("refuses an entity related to itself", () => {
    const selfEdge: Relation = {
      name: "blocks",
      from: { id: "task-1", type: "Task" },
      to: { id: "task-1", type: "Task" },
    };

    expect(diffRelations([selfEdge], []).changes).toEqual([]);
  });

  it("keeps accepting the valid relations claimed alongside a refused one", () => {
    const wrong: Relation = {
      name: "knows",
      from: { id: "per-sarah", type: "Person" },
      to: { id: "proj-helios", type: "Project" },
    };

    const { changes, refused } = diffRelations([wrong, INVOLVES], []);

    expect(changes).toHaveLength(1);
    expect(refused).toHaveLength(1);
  });
});

/**
 * **`knows` is only recorded when a note says so, never inferred from
 * co-occurrence** (`schema.md` §6, `qa.md` §7.3).
 *
 * An easy and tempting bug that would fill the graph with noise. The scorer
 * reads co-occurrence as a *resolution* feature, and letting that same signal
 * write an edge is the failure — two people appearing in one note is not two
 * people knowing each other.
 */
describe("`knows` is never inferred from co-occurrence", () => {
  const SARAH = { id: "per-sarah", type: "Person" as const };
  const MARCO = { id: "per-marco", type: "Person" as const };

  it("emits no `knows` when two people are resolved from one note and neither claims it", () => {
    // Both people were mentioned in one Capture and both resolved. The note
    // claimed only that the project involves each of them.
    const claimed: Relation[] = [
      { name: "involves", from: { id: "proj-helios", type: "Project" }, to: SARAH },
      { name: "involves", from: { id: "proj-helios", type: "Project" }, to: MARCO },
    ];

    const { changes } = diffRelations(claimed, []);

    const knowsEdges = changes.filter((change) => change.payload.relation === "knows");
    expect(knowsEdges, "co-occurrence must not manufacture a `knows`").toEqual([]);
    expect(changes).toHaveLength(2);
  });

  it("emits a `knows` when a note does claim one", () => {
    const claimed: Relation[] = [{ name: "knows", from: SARAH, to: MARCO }];

    const { changes } = diffRelations(claimed, []);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.payload.relation).toBe("knows");
  });

  /**
   * The structural half, so the test above does not become vacuous the moment
   * something else starts producing relations: the relation differ must not
   * read co-occurrence at all. If it ever imports the scorer, the guarantee
   * stops being "nothing infers it" and becomes "nothing infers it yet".
   */
  it("gives the relation differ no access to the co-occurrence signal", async () => {
    const source = await readFile(
      resolve(import.meta.dirname, "../../src/inference/differ/diff-relations.ts"),
      "utf8",
    );

    const imports = source.split("\n").filter((line) => line.startsWith("import"));
    expect(imports.some((line) => line.includes("scoring"))).toBe(false);
    expect(imports.some((line) => line.includes("coResolved"))).toBe(false);
  });
});
