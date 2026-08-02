import { beforeEach, describe, expect, it } from "vitest";
import { BriefWriting, briefIdFor } from "../../src/application/pipeline/write-brief.js";
import { BriefReads } from "../../src/application/surface/read-briefs.js";
import { createStorage, type Storage } from "../../src/composition-root.js";
import { InMemoryBriefGenerator } from "../../src/infrastructure/llm/in-memory-brief-generator.js";
import type { BriefSelection } from "../../src/inference/salience/brief-selection.js";
import { selectDaily } from "../../src/inference/salience/select-daily.js";
import { NOW, daysAgo, entity, salient } from "../inference/salience-fixtures.js";

/**
 * Briefs as they are stored and surfaced (`salience.md` §4, PRD §5.7), and the
 * v0→v1 instrumentation that ships with them (`salience.md` §5).
 */

const GENERATED_AT = NOW;

let storage: Storage;
let writing: BriefWriting;
let reads: BriefReads;

beforeEach(() => {
  storage = createStorage();
  writing = new BriefWriting(storage.briefs, new InMemoryBriefGenerator());
  reads = new BriefReads(storage.briefs);
  return () => storage.close();
});

describe("a brief is stored", () => {
  it("round-trips its prose and selection", async () => {
    const { brief } = await writing.write(aSelection(), GENERATED_AT);

    const stored = await reads.byId(brief.briefId);

    expect(stored?.prose).toContain("Draft the report");
    expect(stored?.selection.sections).toHaveLength(brief.selection.sections.length);
  });

  it("is listed among the recent briefs of its kind", async () => {
    await writing.write(aSelection(), GENERATED_AT);

    expect(await reads.recent("daily")).toHaveLength(1);
    expect(await reads.recent("weekly")).toHaveLength(0);
  });

  it("takes an id derived from its kind and the date it covers", async () => {
    const { brief } = await writing.write(aSelection(), GENERATED_AT);

    expect(brief.briefId).toBe(briefIdFor("daily", NOW));
    expect(brief.briefId).toBe("daily-2026-08-02");
  });
});

/**
 * "A brief is not regenerated once written. It is a record of what mattered on
 * that day, and rewriting history is not something Otto does anywhere else
 * either" (`salience.md` §4).
 */
describe("a brief is never regenerated", () => {
  it("keeps the first brief when the same day is composed twice", async () => {
    const first = await writing.write(aSelection("Draft the report"), GENERATED_AT);
    const second = await writing.write(aSelection("Something else entirely"), GENERATED_AT);

    expect(second.wasStored).toBe(false);
    expect(second.brief.prose).toBe(first.brief.prose);
    expect(second.brief.prose).toContain("Draft the report");
  });

  it("stores one row for a day however many times it runs", async () => {
    await writing.write(aSelection(), GENERATED_AT);
    await writing.write(aSelection(), GENERATED_AT);

    expect(await reads.recent("daily")).toHaveLength(1);
  });

  /** A repeated run must cost no model call at all. */
  it("does not call the generator when a brief already exists", async () => {
    let calls = 0;
    const counting = {
      async generate() {
        calls += 1;
        return { prose: "fresh", provider: "x", modelVersion: "y" };
      },
    };
    await writing.write(aSelection(), GENERATED_AT);

    await new BriefWriting(storage.briefs, counting).write(aSelection(), GENERATED_AT);

    expect(calls).toBe(0);
  });
});

/** The tray badge is the only signal briefs get (PRD §5.7). */
describe("the unread badge", () => {
  it("counts a new brief", async () => {
    await writing.write(aSelection(), GENERATED_AT);

    expect(await reads.unreadCount()).toBe(1);
  });

  it("clears once the brief is opened", async () => {
    const { brief } = await writing.write(aSelection(), GENERATED_AT);

    await reads.open(brief.briefId, NOW);

    expect(await reads.unreadCount()).toBe(0);
  });

  it("counts nothing when no brief has been written", async () => {
    expect(await reads.unreadCount()).toBe(0);
  });
});

/**
 * `salience.md` §5: which entities appeared in each brief, which of those the
 * user then opened, and which high-salience entities the user opened without a
 * brief having surfaced them — "a precision and recall signal for the selection
 * rules, gathered passively with no feedback UI".
 */
describe("the v0 to v1 instrumentation", () => {
  it("records which entities a brief surfaced", async () => {
    await writing.write(aSelection(), GENERATED_AT);

    expect((await reads.attention()).surfaced).toBe(1);
  });

  it("credits a brief when the user opens something it surfaced", async () => {
    const { brief } = await writing.write(aSelection(), GENERATED_AT);

    await reads.recordEntityOpened({
      entityId: "t0",
      openedAt: NOW,
      salience: 65,
      fromBriefId: brief.briefId,
    });

    expect(await reads.attention()).toMatchObject({ surfaced: 1, surfacedAndOpened: 1 });
  });

  it("records an open no brief surfaced, with its salience", async () => {
    await writing.write(aSelection(), GENERATED_AT);

    await reads.recordEntityOpened({ entityId: "unseen", openedAt: NOW, salience: 80 });

    expect(await reads.attention()).toMatchObject({
      openedUnsurfaced: 1,
      meanUnsurfacedSalience: 80,
    });
  });

  /**
   * A dashboard passing the currently-open brief's id would otherwise credit it
   * for every entity reached from that screen — which is exactly the number
   * that would make v0 look better than it is.
   */
  it("refuses credit for an entity the named brief did not surface", async () => {
    const { brief } = await writing.write(aSelection(), GENERATED_AT);

    await reads.recordEntityOpened({
      entityId: "never-selected",
      openedAt: NOW,
      salience: 40,
      fromBriefId: brief.briefId,
    });

    expect(await reads.attention()).toMatchObject({
      surfacedAndOpened: 0,
      openedUnsurfaced: 1,
    });
  });

  it("reports zero mean salience when nothing was missed", async () => {
    expect((await reads.attention()).meanUnsurfacedSalience).toBe(0);
  });
});

/**
 * The distinction the table names carry (`schema.ts`, ADR-0015): the selection
 * *rules* are a projection and rebuild from the log, while a brief is a record
 * of having applied them on a day and does not.
 *
 * Dropping every projection must therefore leave briefs untouched. If it did
 * not, a routine rebuild (ADR-0005) would destroy the history the briefs exist
 * to be.
 */
describe("briefs survive a projection rebuild", () => {
  it("keeps stored briefs when the projections are reset", async () => {
    const { brief } = await writing.write(aSelection(), GENERATED_AT);

    await storage.projections.reset();

    expect(await reads.byId(brief.briefId)).toBeDefined();
    expect(await reads.recent("daily")).toHaveLength(1);
  });

  it("keeps the instrumentation too", async () => {
    await writing.write(aSelection(), GENERATED_AT);
    await reads.recordEntityOpened({ entityId: "unseen", openedAt: NOW, salience: 80 });

    await storage.projections.reset();

    expect(await reads.attention()).toMatchObject({ surfaced: 1, openedUnsurfaced: 1 });
  });
});

/** A daily selection holding one open Task per name given. */
function aSelection(...names: readonly string[]): BriefSelection {
  const chosen = names.length === 0 ? ["Draft the report"] : names;
  const tasks = chosen.map((name, index) =>
    salient(
      {
        ...entity("Task", `t${index}`, { status: "open" }),
        fields: { name: [name], status: ["open"] },
      },
      daysAgo(1),
    ),
  );
  return selectDaily(tasks, [], NOW);
}
