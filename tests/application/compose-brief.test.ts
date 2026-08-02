import { describe, expect, it } from "vitest";
import { QUIET_DAY_PROSE, composeBrief } from "../../src/application/pipeline/compose-brief.js";
import { InMemoryBriefGenerator } from "../../src/infrastructure/llm/in-memory-brief-generator.js";
import type { BriefSelection } from "../../src/inference/salience/brief-selection.js";
import { selectDaily } from "../../src/inference/salience/select-daily.js";
import { NOW, daysAgo, entity, salient } from "../inference/salience-fixtures.js";

/**
 * `qa.md` §10 and §11 keep brief generation at smoke level: **a brief
 * generates, is non-empty, and contains no entity that was not selected**
 * (ADD §8). Whether the prose is any good is a product question no test
 * answers.
 */

describe("a brief generates", () => {
  it("produces non-empty prose over the selection", async () => {
    const brief = await composeBrief(selectionWith("Draft the report"), generator());

    expect(brief.prose.length).toBeGreaterThan(0);
    expect(brief.prose).toContain("Draft the report");
  });

  it("records what generated it", async () => {
    const brief = await composeBrief(selectionWith("Draft the report"), generator());

    expect(brief).toMatchObject({ provider: "in-memory", modelVersion: "canned" });
  });

  it("keeps the selection alongside the prose", async () => {
    const selection = selectionWith("Draft the report");

    const brief = await composeBrief(selection, generator());

    expect(brief.selection).toBe(selection);
  });
});

/**
 * The constraint the differ places on extraction, applied to generation
 * (ADD §8). Unlike `Adjudicator`'s index, prose cannot be made structurally
 * incapable of naming something — so it is checked.
 */
describe("the generator cannot introduce unselected entities", () => {
  it("accepts prose naming only selected entities", async () => {
    const generated = generator("Draft the report is worth doing today.");

    const brief = await composeBrief(selectionWith("Draft the report"), generated);

    expect(brief.unselectedMentions).toEqual([]);
    expect(brief.prose).toContain("worth doing");
  });

  it("refuses prose naming an entity that was not selected", async () => {
    const generated = generator("You should also call Mortimer about the contract.");

    const brief = await composeBrief(selectionWith("Draft the report"), generated);

    expect(brief.unselectedMentions).toContain("Mortimer");
  });

  /**
   * The brief still has to exist — it is the record of what mattered that day,
   * and dropping it because the prose was wrong would lose the selection too.
   */
  it("falls back to the selection rendered plainly", async () => {
    const generated = generator("You should also call Mortimer about the contract.");

    const brief = await composeBrief(selectionWith("Draft the report"), generated);

    expect(brief.prose).toContain("Draft the report");
    expect(brief.prose).not.toContain("Mortimer");
  });

  /** A generator is free to leave things out; only additions are refused. */
  it("accepts prose that omits a selected entity", async () => {
    const selection = selectionWith("Draft the report", "Call the printer");
    const generated = generator("Draft the report is the one that matters.");

    const brief = await composeBrief(selection, generated);

    expect(brief.unselectedMentions).toEqual([]);
  });

  /** Refusing "Sarah" for "Sarah Chen" would make the check fire constantly. */
  it("accepts a first name for a selected full name", async () => {
    const selection = selectionWith("Sarah Chen");
    const generated = generator("Sarah has been quiet for a while.");

    const brief = await composeBrief(selection, generated);

    expect(brief.unselectedMentions).toEqual([]);
  });

  /**
   * The hole a word-by-word check leaves: two selected names supply the words
   * for a third nobody selected. Runs are matched whole against whole names.
   */
  it("refuses a name assembled from words of two selected names", async () => {
    const selection = selectionWith("Sarah Chen", "Acme Project");
    const generated = generator("A decision is due on Chen Project this week.");

    const brief = await composeBrief(selection, generated);

    expect(brief.unselectedMentions).toContain("Chen Project");
  });

  it("still accepts a selected name used whole", async () => {
    const selection = selectionWith("Sarah Chen", "Acme Project");
    const generated = generator("Acme Project is waiting on Sarah Chen.");

    const brief = await composeBrief(selection, generated);

    expect(brief.unselectedMentions).toEqual([]);
  });

  it("does not flag weekdays and months", async () => {
    const generated = generator("Draft the report is due Tuesday, ahead of the August deadline.");

    const brief = await composeBrief(selectionWith("Draft the report"), generated);

    expect(brief.unselectedMentions).toEqual([]);
  });
});

/**
 * "If everything is empty, the brief says so in one line. That is a legitimate
 * output" (`salience.md` §4).
 */
describe("a quiet day", () => {
  it("says so in one line", async () => {
    const brief = await composeBrief(quietSelection(), generator());

    expect(brief.prose).toBe(QUIET_DAY_PROSE);
  });

  /** Asking a model to write about nothing is how manufactured content gets in. */
  it("does not call the generator at all", async () => {
    let calls = 0;
    const counting = {
      async generate() {
        calls += 1;
        return { prose: "invented", provider: "x", modelVersion: "y" };
      },
    };

    await composeBrief(quietSelection(), counting);

    expect(calls).toBe(0);
  });
});

function generator(prose?: string): InMemoryBriefGenerator {
  return new InMemoryBriefGenerator(prose === undefined ? {} : { prose });
}

/** A daily selection holding one open Task per name given. */
function selectionWith(...names: readonly string[]): BriefSelection {
  const tasks = names.map((name, index) =>
    salient(
      { ...entity("Task", `t${index}`, { status: "open" }), fields: taskFields(name) },
      daysAgo(1),
    ),
  );
  return selectDaily(tasks, [], NOW);
}

function taskFields(name: string): Record<string, readonly string[]> {
  return { name: [name], status: ["open"] };
}

function quietSelection(): BriefSelection {
  return selectDaily([], [], NOW);
}
