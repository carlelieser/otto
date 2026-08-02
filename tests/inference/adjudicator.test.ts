import { describe, expect, it } from "vitest";
import { InMemoryAdjudicator } from "../../src/infrastructure/llm/in-memory-adjudicator.js";
import { LocalAdjudicator } from "../../src/infrastructure/llm/local-adjudicator.js";
import { adjudicationPrompt } from "../../src/infrastructure/llm/shared/adjudication-prompt.js";
import { parseChoice } from "../../src/inference/resolution/parse-adjudication.js";
import type { AdjudicationRequest } from "../../src/ports/adjudicator.js";

const A_REQUEST: AdjudicationRequest = {
  noteText: "Coffee with Sarah about the Helios rollout.",
  mentionText: "Sarah",
  entityType: "Person",
  candidates: [
    { name: "Sarah Chen", summary: "Colleague at Acme, works on Helios." },
    { name: "Sarah Okonkwo", summary: "Friend, lives in Lisbon." },
  ],
};

/** A `fetch` answering with one canned chat completion. */
function answering(content: string, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("reading an adjudicator's answer", () => {
  it("converts the model's one-based choice to a zero-based index", () => {
    expect(parseChoice({ choice: 1 }, 3)).toBe(0);
    expect(parseChoice({ choice: 3 }, 3)).toBe(2);
  });

  it("reads an explicit null as none of these", () => {
    expect(parseChoice({ choice: null }, 3)).toBeNull();
  });

  /**
   * A model answering `7` to a list of three has not chosen anything. Reading
   * that as none-of-these follows ADR-0009's bias: picking anyway attaches a
   * fact to the wrong person, which is the expensive failure.
   */
  it("reads a choice past the end of the list as none of these", () => {
    expect(parseChoice({ choice: 7 }, 3)).toBeNull();
  });

  it("reads a zero or negative choice as none of these", () => {
    expect(parseChoice({ choice: 0 }, 3)).toBeNull();
    expect(parseChoice({ choice: -1 }, 3)).toBeNull();
  });

  it("reads a missing or non-numeric choice as none of these", () => {
    expect(parseChoice({}, 3)).toBeNull();
    expect(parseChoice({ choice: "Sarah Chen" }, 3)).toBeNull();
    expect(parseChoice(null, 3)).toBeNull();
  });

  it("reads a fractional choice as none of these", () => {
    expect(parseChoice({ choice: 1.5 }, 3)).toBeNull();
  });
});

describe("the adjudication prompt", () => {
  /**
   * The model never sees an entity id, which is what makes "it cannot invent
   * one" structural rather than a validation someone has to remember
   * (`add.md` §5.3).
   */
  it("names no entity ids", () => {
    const prompt = adjudicationPrompt(A_REQUEST);

    expect(prompt).not.toMatch(/per-|proj-|task-/);
  });

  it("numbers the candidates from one", () => {
    const prompt = adjudicationPrompt(A_REQUEST);

    expect(prompt).toContain("1. Sarah Chen");
    expect(prompt).toContain("2. Sarah Okonkwo");
  });

  it("carries the note, the mention, and the type", () => {
    const prompt = adjudicationPrompt(A_REQUEST);

    expect(prompt).toContain("Coffee with Sarah about the Helios rollout.");
    expect(prompt).toContain('"Sarah"');
    expect(prompt).toContain("Person");
  });

  /** A model given a list picks from it unless told declining is a real answer. */
  it("tells the model that none-of-these is a correct answer", () => {
    expect(adjudicationPrompt(A_REQUEST)).toMatch(/none of the candidates/i);
  });
});

describe("the local adjudicator", () => {
  it("returns the chosen candidate's index", async () => {
    const adjudicator = new LocalAdjudicator({}, answering('{"choice": 1}'));

    expect((await adjudicator.adjudicate(A_REQUEST)).chosenIndex).toBe(0);
  });

  it("returns none of these when the model declines", async () => {
    const adjudicator = new LocalAdjudicator({}, answering('{"choice": null}'));

    expect((await adjudicator.adjudicate(A_REQUEST)).chosenIndex).toBeNull();
  });

  it("declines rather than throwing when the model names a candidate off the list", async () => {
    const adjudicator = new LocalAdjudicator({}, answering('{"choice": 9}'));

    expect((await adjudicator.adjudicate(A_REQUEST)).chosenIndex).toBeNull();
  });

  it("records the provider and model on its answer", async () => {
    const adjudicator = new LocalAdjudicator({ model: "qwen3-8b" }, answering('{"choice": 1}'));

    const adjudication = await adjudicator.adjudicate(A_REQUEST);
    expect(adjudication.provider).toBe("local");
    expect(adjudication.modelVersion).toBe("qwen3-8b");
  });

  /**
   * An unreachable model is "adjudication did not happen", which the pipeline
   * handles by leaving Captures accumulating — a different thing from a
   * considered decline, which is a decision.
   */
  it("throws when the runtime refuses", async () => {
    const adjudicator = new LocalAdjudicator({}, answering("", 500));

    await expect(adjudicator.adjudicate(A_REQUEST)).rejects.toThrow(/local/);
  });

  it("throws when the answer is not JSON", async () => {
    const adjudicator = new LocalAdjudicator({}, answering("the first one"));

    await expect(adjudicator.adjudicate(A_REQUEST)).rejects.toThrow(/not JSON/);
  });
});

describe("the in-memory adjudicator", () => {
  /**
   * Declining is the answer the design prefers when unsure, so it is the answer
   * the stub gives when it has not been told. A stub picking the first
   * candidate would make every unfixtured ambiguous case resolve to something.
   */
  it("declines when it has no fixture for the mention", async () => {
    const adjudicator = new InMemoryAdjudicator();

    expect((await adjudicator.adjudicate(A_REQUEST)).chosenIndex).toBeNull();
  });

  it("returns the canned choice for a fixtured mention", async () => {
    const adjudicator = new InMemoryAdjudicator({ choices: [["Sarah", 1]] });

    expect((await adjudicator.adjudicate(A_REQUEST)).chosenIndex).toBe(1);
  });

  /**
   * A stub that accepts what the real adapter refuses is two implementations
   * that silently disagree — the failure `add.md` §9 records from Slice 0.
   */
  it("refuses a canned choice that is not on the candidate list", async () => {
    const adjudicator = new InMemoryAdjudicator({ choices: [["Sarah", 9]] });

    expect((await adjudicator.adjudicate(A_REQUEST)).chosenIndex).toBeNull();
  });

  it("does not claim to be the local model", async () => {
    const adjudication = await new InMemoryAdjudicator().adjudicate(A_REQUEST);

    expect(adjudication.provider).toBe("in-memory");
  });
});
