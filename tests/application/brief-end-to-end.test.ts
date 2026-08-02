import { beforeEach, describe, expect, it } from "vitest";
import { BriefProduction } from "../../src/application/pipeline/produce-brief.js";
import { BriefReads } from "../../src/application/surface/read-briefs.js";
import { createExecutor, createStorage, type Storage } from "../../src/composition-root.js";
import { InMemoryBriefGenerator } from "../../src/infrastructure/llm/in-memory-brief-generator.js";
import { V0_COEFFICIENTS } from "../../src/inference/salience/coefficients.js";
import type { Command } from "../../src/domain/commands/command.js";
import { CREATE_ENTITY, SET_FIELD } from "../../src/domain/commands/knowledge-commands.js";
import { aProvenance } from "../support/builders.js";

/**
 * A brief produced from the event log and nothing else — the slice's "Done
 * when: daily and weekly briefs generate".
 *
 * This is the seam the unit tests above it cannot cover: that the log actually
 * yields the timing salience scores on. Everything the score reads —
 * `lastMentionedAt`, `createdAt`, the change counts — is derived here from
 * events, which is what makes salience a projection (ADR-0015) rather than a
 * function of state someone remembered to maintain.
 */

const NOW = "2026-08-02T12:00:00.000Z";

let storage: Storage;
let production: BriefProduction;
let reads: BriefReads;

beforeEach(() => {
  storage = createStorage();
  production = new BriefProduction({
    events: storage.events,
    briefs: storage.briefs,
    generator: new InMemoryBriefGenerator(),
  });
  reads = new BriefReads(storage.briefs);
  return () => storage.close();
});

describe("a daily brief from the log", () => {
  it("surfaces an open Task the log created", async () => {
    await given(anOpenTask("t1", "Draft the report"), setStatus("t1", "open", 1));

    const { brief } = await production.produce("daily", NOW);

    expect(brief.prose).toContain("Draft the report");
    expect(brief.selection.sections.length).toBeGreaterThan(0);
  });

  it("scores from the log rather than from a supplied timestamp", async () => {
    await given(anOpenTask("t1", "Draft the report"), setStatus("t1", "open", 1));

    const { brief } = await production.produce("daily", NOW);
    const [selected] = brief.selection.sections[0]!.entities;

    // Applied moments ago in test time, so recency is at or near its maximum.
    expect(selected!.salience.terms.recency).toBeGreaterThan(0);
    expect(selected!.salience.terms.openLoop).toBe(V0_COEFFICIENTS.openLoop);
  });

  it("says so in one line when the log holds nothing", async () => {
    const { brief } = await production.produce("daily", NOW);

    expect(brief.selection.sections).toEqual([]);
    expect(brief.prose).toContain("Nothing needs your attention");
  });

  /** The id is derived from the date, so a scheduler that fires twice writes once. */
  it("writes one brief however many times it runs", async () => {
    await given(anOpenTask("t1", "Draft the report"));

    const first = await production.produce("daily", NOW);
    const second = await production.produce("daily", NOW);

    expect(second.wasStored).toBe(false);
    expect(second.brief.briefId).toBe(first.brief.briefId);
    expect(await reads.recent("daily")).toHaveLength(1);
  });
});

describe("a weekly brief from the log", () => {
  it("reports what the log created this week", async () => {
    await given(anOpenTask("t1", "Draft the report"));

    const { brief } = await production.produce("weekly", NOW);

    expect(headings(brief.selection)).toContain("New this week");
    expect(brief.prose).toContain("Draft the report");
  });

  /** A status change is visible only in the log; the folded entity has lost it. */
  it("reports a status change as movement", async () => {
    await given(anOpenTask("t1", "Draft the report"), setStatus("t1", "done", 1));

    const { brief } = await production.produce("weekly", NOW);

    expect(headings(brief.selection)).toContain("What moved");
  });

  it("is stored under its own kind", async () => {
    await given(anOpenTask("t1", "Draft the report"));

    await production.produce("weekly", NOW);

    expect(await reads.recent("weekly")).toHaveLength(1);
    expect(await reads.recent("daily")).toHaveLength(0);
  });
});

/** Applies commands through the real executor, so the log is genuinely written. */
async function given(...commands: readonly Command[]): Promise<void> {
  const executor = createExecutor(storage.events, () => NOW);
  for (const command of commands) await executor.execute(command);
}

function anOpenTask(id: string, name: string): Command {
  return {
    type: CREATE_ENTITY,
    aggregate: { type: "Entity", id, expectedVersion: 0 },
    payload: { entityType: "Task", name },
    provenance: aProvenance(),
  };
}

function setStatus(id: string, status: string, expectedVersion: number): Command {
  return {
    type: SET_FIELD,
    aggregate: { type: "Entity", id, expectedVersion },
    payload: { field: "status", value: status },
    provenance: aProvenance(),
  };
}

function headings(selection: { sections: readonly { heading: string }[] }): readonly string[] {
  return selection.sections.map((section) => section.heading);
}
