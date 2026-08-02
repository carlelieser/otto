import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ADD_TO_SET,
  CLEAR_FIELD,
  SET_FIELD,
} from "../../src/domain/commands/knowledge-commands.js";
import { ENTITY_SCHEMA, ENTITY_TYPES } from "../../src/domain/schema/entity-schema.js";
import { diffEntity, floorFor } from "../../src/inference/differ/diff-entity.js";
import { anEntity, anEntityOfType, aResolvedDate } from "../support/knowledge-builders.js";

/**
 * `qa.md` §7.2. Every rule here is exactly assertable, because the differ has
 * no LLM in it — which is the same property that makes it the stage where
 * hallucination is structurally prevented.
 */

describe("cardinality read from the schema", () => {
  /** `employer` is `single`: the job history lives in the event log, not in a set. */
  it("supersedes a single field given a new value", () => {
    const sarah = anEntity({ fields: { employer: ["Acme"] } });

    const { changes } = diffEntity(sarah, [{ field: "employer", value: "Globex" }]);

    expect(changes).toEqual([{ type: SET_FIELD, payload: { field: "employer", value: "Globex" } }]);
  });

  it("sets a single field that held nothing", () => {
    const { changes } = diffEntity(anEntity(), [{ field: "employer", value: "Acme" }]);

    expect(changes[0]?.type).toBe(SET_FIELD);
  });

  /** `contact` is a `set` because people have several and rarely lose them. */
  it("unions a set field rather than replacing it", () => {
    const sarah = anEntity({ fields: { contact: ["sarah@acme.com"] } });

    const { changes } = diffEntity(sarah, [{ field: "contact", value: "@sarah" }]);

    expect(changes).toEqual([{ type: ADD_TO_SET, payload: { field: "contact", value: "@sarah" } }]);
  });

  /**
   * The property `qa.md` §7.2 states in bold. There is no Command in the
   * vocabulary that removes a set member, so this holds structurally — but the
   * test is what says so, because a future `SetField` on a set field would
   * break it silently.
   */
  it("never drops a member of a set field, for any claimed value", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }),
        fc.string({ minLength: 1 }),
        (held, claimed) => {
          const sarah = anEntity({ fields: { contact: held } });

          const { changes } = diffEntity(sarah, [{ field: "contact", value: claimed }]);

          const isAdditiveOnly = changes.every((change) => change.type === ADD_TO_SET);
          expect(isAdditiveOnly, "a set field only ever gains members").toBe(true);
        },
      ),
    );
  });

  it("reads cardinality from the schema rather than from a list of field names", () => {
    // `aliases` and `notes` are `set` on every entity type; `summary` is `single`.
    const sarah = anEntity({ fields: { aliases: ["Sar"], summary: ["A colleague"] } });

    const { changes } = diffEntity(sarah, [
      { field: "aliases", value: "S. Chen" },
      { field: "summary", value: "A colleague at Acme" },
    ]);

    expect(changes.map((change) => change.type)).toEqual([ADD_TO_SET, SET_FIELD]);
  });
});

describe("the no-op diff", () => {
  /** What stops a re-extraction confirming current belief from filling the queue. */
  it("produces no Command when a single field already holds the claimed value", () => {
    const sarah = anEntity({ fields: { employer: ["Acme"] } });

    expect(diffEntity(sarah, [{ field: "employer", value: "Acme" }]).changes).toEqual([]);
  });

  it("produces no Command when a set field already contains the claimed member", () => {
    const sarah = anEntity({ fields: { contact: ["sarah@acme.com"] } });

    expect(diffEntity(sarah, [{ field: "contact", value: "sarah@acme.com" }]).changes).toEqual([]);
  });

  it("produces no Command for no claimed values", () => {
    expect(diffEntity(anEntity(), []).changes).toEqual([]);
  });

  /**
   * A date compares on its instant *and* its precision: "sometime next quarter"
   * and "on the 4th" can resolve to one instant and are not the same value.
   */
  it("produces no Command for a date claimed again at the same precision", () => {
    const due = aResolvedDate();
    const project = anEntityOfType("Project", { fields: { due: [due] } });

    expect(diffEntity(project, [{ field: "due", value: { ...due } }]).changes).toEqual([]);
  });

  it("supersedes a date whose precision changed at the same instant", () => {
    const day = aResolvedDate({ precision: "day" });
    const project = anEntityOfType("Project", { fields: { due: [day] } });

    const { changes } = diffEntity(project, [
      { field: "due", value: { ...day, precision: "quarter" } },
    ]);

    expect(changes[0]?.type).toBe(SET_FIELD);
  });
});

/** `schema.md` §4, via the dependency table rather than a branch in the differ. */
describe("dependent fields", () => {
  const blocked = anEntityOfType("Project", {
    fields: { status: ["blocked"], blocker: ["waiting on the contract"] },
  });

  it("clears `blocker` when status changes away from `blocked`", () => {
    const { changes } = diffEntity(blocked, [{ field: "status", value: "active" }]);

    expect(changes).toContainEqual({
      type: CLEAR_FIELD,
      payload: { field: "blocker", because: "status" },
    });
  });

  it("does not clear `blocker` when the status stays `blocked`", () => {
    const { changes } = diffEntity(blocked, [{ field: "status", value: "blocked" }]);

    expect(changes).toEqual([]);
  });

  /** A note repeating "still blocked" must not clear the blocker it also repeated. */
  it("does not clear `blocker` when a claim restates the current status", () => {
    const { changes } = diffEntity(blocked, [
      { field: "status", value: "blocked" },
      { field: "blocker", value: "waiting on the contract" },
    ]);

    expect(changes).toEqual([]);
  });

  it("does not clear a `blocker` that was never set", () => {
    const active = anEntityOfType("Project", { fields: { status: ["blocked"] } });

    const { changes } = diffEntity(active, [{ field: "status", value: "done" }]);

    expect(changes.every((change) => change.type !== CLEAR_FIELD)).toBe(true);
  });

  it("clears `blocker` for every status that is not `blocked`", () => {
    for (const status of ["active", "paused", "done", "abandoned"]) {
      const { changes } = diffEntity(blocked, [{ field: "status", value: status }]);

      expect(changes, status).toContainEqual({
        type: CLEAR_FIELD,
        payload: { field: "blocker", because: "status" },
      });
    }
  });
});

/**
 * `qa.md` §7.2 asks for both halves: the drop, and the log. `salience` and
 * `last_contact_at` are computed by projection and can never appear in a
 * Proposal.
 */
describe("derived fields", () => {
  it("refuses a claimed `salience` rather than accepting it", () => {
    const { changes, refused } = diffEntity(anEntity(), [{ field: "salience", value: "0.9" }]);

    expect(changes).toEqual([]);
    expect(refused).toEqual([{ field: "salience", reason: "derived_field" }]);
  });

  it("refuses a claimed `last_contact_at`", () => {
    const { refused } = diffEntity(anEntity(), [
      { field: "last_contact_at", value: aResolvedDate() },
    ]);

    expect(refused).toEqual([{ field: "last_contact_at", reason: "derived_field" }]);
  });

  it("refuses every derived field the schema declares, on every entity type", () => {
    for (const entityType of ENTITY_TYPES) {
      const derived = ENTITY_SCHEMA[entityType].filter(
        (field) => field.extractability === "derived",
      );
      for (const field of derived) {
        const { changes, refused } = diffEntity(anEntityOfType(entityType), [
          { field: field.name, value: "anything" },
        ]);

        expect(changes, `${entityType}.${field.name}`).toEqual([]);
        expect(refused[0]?.reason, `${entityType}.${field.name}`).toBe("derived_field");
      }
    }
  });

  it("keeps accepting the extractable values claimed alongside a refused one", () => {
    const { changes, refused } = diffEntity(anEntity(), [
      { field: "salience", value: "0.9" },
      { field: "employer", value: "Acme" },
    ]);

    expect(changes).toHaveLength(1);
    expect(refused).toHaveLength(1);
  });
});

/**
 * Should be structurally impossible: the output schema is generated from
 * `schema.md`, so an unknown name fails parsing before the differ. Tested
 * because "should be impossible" is a claim a test has to be able to make.
 */
describe("unknown fields", () => {
  it("refuses a field the schema does not declare", () => {
    const { changes, refused } = diffEntity(anEntity(), [{ field: "shoe_size", value: "42" }]);

    expect(changes).toEqual([]);
    expect(refused).toEqual([{ field: "shoe_size", reason: "unknown_field" }]);
  });

  /** `employer` on a Project is as wrong as `shoe_size` on a Person. */
  it("refuses a field that belongs to a different entity type", () => {
    const { refused } = diffEntity(anEntityOfType("Project"), [
      { field: "employer", value: "Acme" },
    ]);

    expect(refused).toEqual([{ field: "employer", reason: "unknown_field" }]);
  });
});

/** `qa.md` §7.2: floors are read from `schema.md`, not hardcoded in the differ. */
describe("per-field floors", () => {
  it("reports the floor the schema declares", () => {
    expect(floorFor("Person", "name")).toBe("review");
    expect(floorFor("Person", "employer")).toBe("auto");
  });

  it("agrees with the schema for every field of every entity type", () => {
    for (const entityType of ENTITY_TYPES) {
      for (const field of ENTITY_SCHEMA[entityType]) {
        expect(floorFor(entityType, field.name), `${entityType}.${field.name}`).toBe(field.floor);
      }
    }
  });

  it("reports no floor for a field the schema does not declare", () => {
    expect(floorFor("Person", "shoe_size")).toBeUndefined();
  });
});
