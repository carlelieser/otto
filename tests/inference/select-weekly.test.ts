import { describe, expect, it } from "vitest";
import { isQuiet } from "../../src/inference/salience/brief-selection.js";
import { WEEKLY_CAPS, selectWeekly } from "../../src/inference/salience/select-weekly.js";
import { NOW, active, daysAgo, entity, salient } from "./salience-fixtures.js";

/**
 * The five weekly sections (`salience.md` §4), given a fixture knowledge base
 * and the change counts the log would have supplied.
 */

describe("What moved", () => {
  it("selects an entity whose status changed this week", () => {
    const moved = active(salient(entity("Project", "p1", { status: "done" }), daysAgo(2)), {
      statusChanged: true,
      changesThisWeek: 1,
    });

    expect(idsUnder(selectWeekly([moved], [], NOW), "What moved")).toEqual(["p1"]);
  });

  it("selects an entity with three changes this week", () => {
    const busy = active(salient(entity("Project", "p1", { status: "active" }), daysAgo(1)), {
      changesThisWeek: 3,
    });

    expect(idsUnder(selectWeekly([busy], [], NOW), "What moved")).toEqual(["p1"]);
  });

  it("does not select an entity with two changes and no status change", () => {
    const quiet = active(salient(entity("Project", "p1", { status: "active" }), daysAgo(1)), {
      changesThisWeek: 2,
    });

    expect(headings(selectWeekly([quiet], [], NOW))).not.toContain("What moved");
  });

  it("caps at 8", () => {
    const many = Array.from({ length: 11 }, (_, index) =>
      active(salient(entity("Project", `p${index}`, { status: "active" }), daysAgo(1)), {
        statusChanged: true,
      }),
    );

    expect(idsUnder(selectWeekly(many, [], NOW), "What moved")).toHaveLength(WEEKLY_CAPS.whatMoved);
  });
});

describe("What didn't", () => {
  it("selects an open loop untouched this week and last", () => {
    const stalled = salient(entity("Task", "t1", { status: "open" }), daysAgo(30));

    expect(idsUnder(selectWeekly([stalled], [], NOW), "What didn't")).toEqual(["t1"]);
  });

  it("does not select an open loop touched this week", () => {
    const touched = active(salient(entity("Task", "t1", { status: "open" }), daysAgo(1)), {
      changesThisWeek: 1,
    });

    expect(headings(selectWeekly([touched], [], NOW))).not.toContain("What didn't");
  });

  /** One quiet week happens to healthy work; two is the signal. */
  it("does not select an open loop touched last week", () => {
    const touched = active(salient(entity("Task", "t1", { status: "open" }), daysAgo(10)), {
      changesLastWeek: 2,
    });

    expect(headings(selectWeekly([touched], [], NOW))).not.toContain("What didn't");
  });

  it("does not select a closed entity however quiet", () => {
    const done = salient(entity("Task", "t1", { status: "done" }), daysAgo(90));

    expect(headings(selectWeekly([done], [], NOW))).not.toContain("What didn't");
  });
});

describe("Open loops", () => {
  it("selects open Tasks and blocked Projects", () => {
    const task = salient(entity("Task", "t1", { status: "open" }), daysAgo(3));
    const blocked = salient(entity("Project", "p1", { status: "blocked" }), daysAgo(3));

    expect([...idsUnder(selectWeekly([task, blocked], [], NOW), "Open loops")].sort()).toEqual([
      "p1",
      "t1",
    ]);
  });

  it("caps at 8", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      salient(entity("Task", `t${index}`, { status: "open" }), daysAgo(3)),
    );

    expect(idsUnder(selectWeekly(many, [], NOW), "Open loops")).toHaveLength(WEEKLY_CAPS.openLoops);
  });
});

describe("New this week", () => {
  it("selects an entity created three days ago", () => {
    const fresh = salient(entity("Idea", "i1", { status: "open" }), daysAgo(3), daysAgo(3));

    expect(idsUnder(selectWeekly([fresh], [], NOW), "New this week")).toEqual(["i1"]);
  });

  it("does not select an entity created nine days ago", () => {
    const older = salient(entity("Idea", "i1", { status: "open" }), daysAgo(9), daysAgo(9));

    expect(headings(selectWeekly([older], [], NOW))).not.toContain("New this week");
  });

  it("caps at 10", () => {
    const many = Array.from({ length: 14 }, (_, index) =>
      salient(entity("Idea", `i${index}`, { status: "open" }), daysAgo(2), daysAgo(2)),
    );

    expect(idsUnder(selectWeekly(many, [], NOW), "New this week")).toHaveLength(
      WEEKLY_CAPS.newThisWeek,
    );
  });
});

describe("People", () => {
  it("selects a Person mentioned this week", () => {
    const seen = salient(entity("Person", "who"), daysAgo(2));

    expect(idsUnder(selectWeekly([seen], [], NOW), "People")).toEqual(["who"]);
  });

  /**
   * `salience.md` §4 calls this "the one most likely to justify the whole
   * feature, and also the most likely to be annoying".
   */
  it("selects a previously frequent Person silent for 60 days", () => {
    const lapsed = active(salient(entity("Person", "who"), daysAgo(90)), { changesEver: 5 });

    expect(idsUnder(selectWeekly([lapsed], [], NOW), "People")).toEqual(["who"]);
  });

  /** The floor is what keeps it from resurfacing everyone ever named once. */
  it("does not resurface a Person mentioned only once long ago", () => {
    const passing = active(salient(entity("Person", "who"), daysAgo(90)), { changesEver: 1 });

    expect(headings(selectWeekly([passing], [], NOW))).not.toContain("People");
  });

  it("does not select a Person silent for only 30 days", () => {
    const recent = active(salient(entity("Person", "who"), daysAgo(30)), { changesEver: 5 });

    expect(headings(selectWeekly([recent], [], NOW))).not.toContain("People");
  });

  it("caps at 6", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      salient(entity("Person", `who${index}`), daysAgo(2)),
    );

    expect(idsUnder(selectWeekly(many, [], NOW), "People")).toHaveLength(WEEKLY_CAPS.people);
  });
});

describe("empty sections are omitted rather than padded", () => {
  it("emits only the sections that selected something", () => {
    const seen = salient(entity("Person", "who"), daysAgo(2), daysAgo(400));

    expect(headings(selectWeekly([seen], [], NOW))).toEqual(["People"]);
  });

  it("returns no sections for an empty knowledge base", () => {
    expect(isQuiet(selectWeekly([], [], NOW))).toBe(true);
  });
});

describe("the window", () => {
  it("covers the seven days ending now", () => {
    const selection = selectWeekly([], [], NOW);

    expect(selection.coversTo).toBe(NOW);
    expect(selection.coversFrom).toBe(daysAgo(7));
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
