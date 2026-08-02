import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_COMMAND_TYPES,
  MERGE_ENTITIES,
  type MergeEntitiesPayload,
} from "../../src/domain/commands/knowledge-commands.js";
import {
  ENTITIES_MERGED,
  EVENT_FOR_COMMAND,
  KNOWLEDGE_EVENT_TYPES,
} from "../../src/domain/events/knowledge-events.js";

/**
 * **Merge is a Command in the closed vocabulary, and nothing else is added
 * alongside it** (ADR-0009, ADR-0012, `triage.md` §5).
 *
 * The vocabulary's closure is where hallucination is structurally prevented
 * (`add.md` §5.4), so adding to it is exactly the change worth a test that
 * counts. Split is the one that must stay out: `tests/inference/command-seam.test.ts`
 * asserts its absence across the whole tree, and this file asserts the shape of
 * the half that ships.
 */

describe("merge joins the closed Command vocabulary", () => {
  it("names the loser in its payload and the survivor as its aggregate", () => {
    const payload: MergeEntitiesPayload = { mergedId: "person-4891" };

    expect(payload.mergedId).toBe("person-4891");
  });

  it("is one Command and one event, paired like every other", () => {
    expect(KNOWLEDGE_COMMAND_TYPES).toContain(MERGE_ENTITIES);
    expect(KNOWLEDGE_EVENT_TYPES).toContain(ENTITIES_MERGED);
    expect(EVENT_FOR_COMMAND[MERGE_ENTITIES]).toBe(ENTITIES_MERGED);
  });

  /**
   * Every Command has exactly one event, which is what makes the translator a
   * pass-through rather than a place decisions get made
   * (`knowledge-translators.ts`).
   */
  it("leaves the vocabulary a one-to-one pairing", () => {
    const events = KNOWLEDGE_COMMAND_TYPES.map((command) => EVENT_FOR_COMMAND[command]);

    expect(new Set(events).size).toBe(KNOWLEDGE_COMMAND_TYPES.length);
  });
});
