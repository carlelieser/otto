import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWLEDGE_COMMAND_TYPES } from "../../src/domain/commands/knowledge-commands.js";
import { InMemoryExtractor } from "../../src/infrastructure/llm/in-memory-extractor.js";
import { InMemoryAdjudicator } from "../../src/infrastructure/llm/in-memory-adjudicator.js";

/**
 * **The model never emits a Command** (`add.md` §5.4, `qa.md` §7.2).
 *
 * Structural, and the reason invented ids and hallucinated field names are
 * impossible — so `qa.md` §7.2 asks for an explicit test of the seam rather
 * than trusting that it stays true. The two halves:
 *
 * 1. What the model-facing ports can *say*. `Extractor` returns Mentions and
 *    claimed values; `Adjudicator` returns an index into a list it was handed.
 *    Neither type can express a Command, so no adapter can produce one however
 *    it is implemented.
 * 2. What the model-facing code *names*. A Command type appearing in an adapter
 *    or a prompt would be the first step toward one being parsed out of model
 *    output, and it is caught here rather than in review.
 */

const SOURCE_ROOT = resolve(import.meta.dirname, "../../src");

/** Every `.ts` file under a directory, recursively. */
async function sourceFilesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFilesUnder(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return files.flat();
}

describe("what a model-facing port can return", () => {
  /**
   * The extractor's whole surface is Mentions, claimed field values, and
   * violations. There is no shape in it that names a Command, an entity id, or
   * an aggregate version.
   */
  it("gives the extractor no way to express a Command", async () => {
    const extraction = await new InMemoryExtractor().extract({
      text: "Coffee with Sarah about Helios.",
      capturedAt: "2026-08-01T09:00:00.000Z",
    });

    const returned = new Set(Object.keys(extraction));
    expect(returned).toEqual(new Set(["mentions", "violations", "provider", "modelVersion"]));
    for (const commandType of KNOWLEDGE_COMMAND_TYPES) {
      expect(JSON.stringify(extraction)).not.toContain(commandType);
    }
  });

  /**
   * The adjudicator answers with a position in a list it was given. It cannot
   * name an entity id because it has never seen one, and it cannot name a
   * Command because the return type has no room for one.
   */
  it("gives the adjudicator no way to express anything but a choice", async () => {
    const adjudication = await new InMemoryAdjudicator().adjudicate({
      noteText: "Coffee with Sarah.",
      mentionText: "Sarah",
      entityType: "Person",
      candidates: [{ name: "Sarah Chen", summary: "A colleague." }],
    });

    expect(new Set(Object.keys(adjudication))).toEqual(
      new Set(["chosenIndex", "provider", "modelVersion"]),
    );
    expect(typeof adjudication.chosenIndex === "number" || adjudication.chosenIndex === null).toBe(
      true,
    );
  });
});

describe("what model-facing code names", () => {
  /**
   * The directories where model output is produced, parsed, or prompted for.
   * A Command type named in any of them is the seam starting to leak.
   */
  const MODEL_FACING = ["infrastructure/llm", "infrastructure/embedding", "inference/extraction"];

  it("names no Command type in any adapter, prompt, or extraction parser", async () => {
    const offenders: string[] = [];

    for (const directory of MODEL_FACING) {
      for (const path of await sourceFilesUnder(join(SOURCE_ROOT, directory))) {
        const text = await readFile(path, "utf8");
        const named = KNOWLEDGE_COMMAND_TYPES.filter((commandType) =>
          new RegExp(`\\b${commandType}\\b`).test(text),
        );
        if (named.length > 0) offenders.push(`${path}: ${named.join(", ")}`);
      }
    }

    expect(offenders, "model-facing code naming a Command type").toEqual([]);
  });

  /**
   * The differ is the only thing that builds a Command, and it is the one stage
   * with no model in it. If it ever imported a model-facing port, "the model
   * never emits a Command" would stop being structural.
   */
  it("keeps the differ free of any model-facing port", async () => {
    const offenders: string[] = [];

    for (const path of await sourceFilesUnder(join(SOURCE_ROOT, "inference/differ"))) {
      const text = await readFile(path, "utf8");
      const isModelFacing = /ports\/(extractor|adjudicator|embedder)/.test(text);
      if (isModelFacing) offenders.push(path);
    }

    expect(offenders, "the differ importing a model-facing port").toEqual([]);
  });

  /**
   * **The correction path does not re-enter the pipeline** (`add.md` §7,
   * `qa.md` §7.7). Asserted structurally rather than with a spy, for the reason
   * ADR-0022 gives about re-proposal: a spy proves the call went unmade on one
   * input, and this proves there is nothing that could make it on any.
   *
   * The user has already decided. Sending their decision back through a model
   * would be Otto second-guessing the only unambiguous signal it gets.
   */
  it("keeps adjudication free of any model-facing port", async () => {
    const path = join(SOURCE_ROOT, "application/pipeline/adjudicate-proposal.ts");

    const text = await readFile(path, "utf8");

    expect(/ports\/(extractor|adjudicator|embedder)/.test(text)).toBe(false);
    expect(/pipeline\/(extract|triage|repropose)/.test(text)).toBe(false);
  });
});

/**
 * **Split is not implemented in MVP** (PRD §7.2, ADR-0009, `qa.md` §7.4).
 *
 * `qa.md` §7.4 asks for a test that no split path exists rather than tests of
 * split behaviour, and Slice 7 repeats the ask because the review queue is
 * where a split affordance would first appear. Split is the half that genuinely
 * needs the full review UI, and unlike merge it has no cheap lossless fallback.
 *
 * The one permitted mention is `application-policy.ts`, where `split` is a row
 * in the rule table that always downgrades to review. A vocabulary entry with
 * no producer is not a path — and keeping the row is what makes the day someone
 * builds one land on a rule that already refuses to auto-apply it.
 */
describe("split has no implementation", () => {
  const POLICY = "domain/policies/application-policy.ts";

  it("names split nowhere but the rule table that refuses it", async () => {
    const offenders: string[] = [];

    for (const path of await sourceFilesUnder(SOURCE_ROOT)) {
      const relative = path.slice(SOURCE_ROOT.length + 1);
      if (relative === POLICY) continue;
      const text = await readFile(path, "utf8");
      if (/\bSplitEntity\b|\bEntitySplit\b|\bsplitEntity\b/.test(text)) offenders.push(relative);
    }

    expect(offenders, "a split Command, event, or handler").toEqual([]);
  });

  it("declares no split Command and no split event", () => {
    const named = [...KNOWLEDGE_COMMAND_TYPES].filter((type) => /split/i.test(type));

    expect(named).toEqual([]);
  });

  /** The queue is where a split affordance would surface first, so check it there. */
  it("offers no split affordance on the review queue", async () => {
    const path = join(SOURCE_ROOT, "application/surface/read-review-queue.ts");

    const text = await readFile(path, "utf8");

    expect(/split/i.test(text)).toBe(false);
  });
});
