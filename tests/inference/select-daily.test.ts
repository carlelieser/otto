import { describe, expect, it } from "vitest";
import { isQuiet, selectedIds } from "../../src/inference/salience/brief-selection.js";
import { DAILY_CAPS, selectDaily } from "../../src/inference/salience/select-daily.js";
import { NOW, daysAgo, entity, salient, task } from "./salience-fixtures.js";

/**
 * `qa.md` §11: given a fixture knowledge base, which entities land in which
 * section, that caps hold, and that empty sections are omitted.
 *
 * Ordinary Tier 1 treatment — the selection beneath a brief is arithmetic, and
 * only the generated prose above it stays smoke-level.
 */

describe("Today", () => {
  it("selects an Event occurring today", () => {
    const meeting = salient(entity("Event", "e1", {}, { occurred_at: daysAgo(0) }), daysAgo(0));

    expect(headings(selectDaily([meeting], [], NOW))).toContain("Today");
    expect(idsUnder(selectDaily([meeting], [], NOW), "Today")).toEqual(["e1"]);
  });

  it("selects a Task due today", () => {
    const due = task("t1", "open", daysAgo(0));

    expect(idsUnder(selectDaily([due], [], NOW), "Today")).toEqual(["t1"]);
  });

  /** A missed deadline is today's problem, which is why overdue lands here. */
  it("selects an overdue open Task", () => {
    const late = task("t1", "open", daysAgo(9));

    expect(idsUnder(selectDaily([late], [], NOW), "Today")).toEqual(["t1"]);
  });

  it("does not select an overdue Task that is done", () => {
    const finished = task("t1", "done", daysAgo(9));

    expect(idsUnder(selectDaily([finished], [], NOW), "Today")).toEqual([]);
  });

  it("caps at 8", () => {
    const many = Array.from({ length: 12 }, (_, index) => task(`t${index}`, "open", daysAgo(0)));

    expect(idsUnder(selectDaily(many, [], NOW), "Today")).toHaveLength(DAILY_CAPS.today);
  });
});

describe("Worth doing", () => {
  it("selects an open Task with no date", () => {
    const someday = salient(entity("Task", "t1", { status: "open" }), daysAgo(2));

    expect(idsUnder(selectDaily([someday], [], NOW), "Worth doing")).toEqual(["t1"]);
  });

  it("selects a Project carrying a next_action", () => {
    const project = salient(
      entity("Project", "p1", { status: "active", next_action: "draft the brief" }),
      daysAgo(2),
    );

    expect(idsUnder(selectDaily([project], [], NOW), "Worth doing")).toEqual(["p1"]);
  });

  it("does not select a Project with no next_action", () => {
    const project = salient(entity("Project", "p1", { status: "active" }), daysAgo(2));

    expect(headings(selectDaily([project], [], NOW))).not.toContain("Worth doing");
  });

  /** Restating "Today" would spend half the two-minute budget saying one thing twice. */
  it("excludes anything Today already listed", () => {
    const due = task("t1", "open", daysAgo(0));

    const selection = selectDaily([due], [], NOW);

    expect(idsUnder(selection, "Today")).toEqual(["t1"]);
    expect(headings(selection)).not.toContain("Worth doing");
  });

  it("caps at 5", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      salient(entity("Task", `t${index}`, { status: "open" }), daysAgo(2)),
    );

    expect(idsUnder(selectDaily(many, [], NOW), "Worth doing")).toHaveLength(DAILY_CAPS.worthDoing);
  });
});

describe("Looks stuck", () => {
  it("selects a blocked Project silent for 14 days", () => {
    const stalled = salient(entity("Project", "p1", { status: "blocked" }), daysAgo(20));

    expect(idsUnder(selectDaily([stalled], [], NOW), "Looks stuck")).toEqual(["p1"]);
  });

  it("selects an open Task silent for 30 days", () => {
    const forgotten = salient(entity("Task", "t1", { status: "open" }), daysAgo(40));

    expect(idsUnder(selectDaily([forgotten], [], NOW), "Looks stuck")).toEqual(["t1"]);
  });

  it("does not select a blocked Project mentioned yesterday", () => {
    const fresh = salient(entity("Project", "p1", { status: "blocked" }), daysAgo(1));

    expect(headings(selectDaily([fresh], [], NOW))).not.toContain("Looks stuck");
  });

  it("caps at 3", () => {
    const many = Array.from({ length: 6 }, (_, index) =>
      salient(entity("Project", `p${index}`, { status: "blocked" }), daysAgo(30)),
    );

    expect(idsUnder(selectDaily(many, [], NOW), "Looks stuck")).toHaveLength(DAILY_CAPS.looksStuck);
  });
});

describe("Coming up", () => {
  it("selects an Event three days out", () => {
    const soon = salient(entity("Event", "e1", {}, { occurred_at: daysAgo(-3) }), daysAgo(1));

    expect(idsUnder(selectDaily([soon], [], NOW), "Coming up")).toEqual(["e1"]);
  });

  it("excludes today, which Today already covers", () => {
    const now = salient(entity("Event", "e1", {}, { occurred_at: daysAgo(0) }), daysAgo(0));

    const selection = selectDaily([now], [], NOW);

    expect(idsUnder(selection, "Today")).toEqual(["e1"]);
    expect(headings(selection)).not.toContain("Coming up");
  });

  it("does not select an Event nine days out", () => {
    const distant = salient(entity("Event", "e1", {}, { occurred_at: daysAgo(-9) }), daysAgo(1));

    expect(headings(selectDaily([distant], [], NOW))).not.toContain("Coming up");
  });

  it("caps at 5", () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      salient(entity("Event", `e${index}`, {}, { occurred_at: daysAgo(-3) }), daysAgo(1)),
    );

    expect(idsUnder(selectDaily(many, [], NOW), "Coming up")).toHaveLength(DAILY_CAPS.comingUp);
  });
});

/**
 * "A brief that manufactures content on a quiet day teaches the user to skim."
 * The omission is the design, and the empty brief is a legitimate output.
 */
describe("empty sections are omitted rather than padded", () => {
  it("emits only the sections that selected something", () => {
    const stalled = salient(entity("Project", "p1", { status: "blocked" }), daysAgo(30));

    expect(headings(selectDaily([stalled], [], NOW))).toEqual(["Looks stuck"]);
  });

  it("returns no sections at all for an empty knowledge base", () => {
    const selection = selectDaily([], [], NOW);

    expect(selection.sections).toEqual([]);
    expect(isQuiet(selection)).toBe(true);
  });

  it("returns no sections when nothing qualifies", () => {
    const settled = salient(entity("Project", "p1", { status: "done" }), daysAgo(90));

    expect(isQuiet(selectDaily([settled], [], NOW))).toBe(true);
  });
});

describe("the selected set", () => {
  /** What the generator is checked against: one id per entity, across sections. */
  it("names every selected entity once", () => {
    const stalled = salient(entity("Project", "p1", { status: "blocked" }), daysAgo(30));
    const due = task("t1", "open", daysAgo(0));

    expect([...selectedIds(selectDaily([stalled, due], [], NOW))].sort()).toEqual(["p1", "t1"]);
  });
});

function headings(selection: { sections: readonly { heading: string }[] }): readonly string[] {
  return selection.sections.map((section) => section.heading);
}

function idsUnder(
  selection: {
    sections: readonly { heading: string; entities: readonly { entityId: string }[] }[];
  },
  heading: string,
): readonly string[] {
  const section = selection.sections.find((candidate) => candidate.heading === heading);
  return (section?.entities ?? []).map((entity) => entity.entityId);
}
