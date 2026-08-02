import { describe, expect, it } from "vitest";
import {
  emptyKnowledge,
  applyEvent,
  entityOf,
  provenanceOf,
  relationsIn,
} from "../../src/domain/knowledge/project-entity.js";
import {
  anEntityCreated,
  aFieldCleared,
  aFieldSet,
  aSetMemberAdded,
  anEntitiesRelated,
} from "../support/projection-builders.js";

describe("folding an EntityCreated event", () => {
  it("creates the entity with its name and type", () => {
    const state = applyEvent(emptyKnowledge(), anEntityCreated());

    const entity = entityOf(state, "per-sarah");
    expect(entity?.type).toBe("Person");
    expect(entity?.fields["name"]).toEqual(["Sarah Chen"]);
  });

  /**
   * The version is the count of events folded into the entity, so a Command's
   * `expectedVersion` checks against the same number the projection reports
   * (`add.md` §5.6).
   */
  it("starts the entity at version 1", () => {
    const state = applyEvent(emptyKnowledge(), anEntityCreated());

    expect(entityOf(state, "per-sarah")?.version).toBe(1);
  });

  it("leaves an already-created entity alone", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const again = applyEvent(created, anEntityCreated({ payload: { name: "Someone Else" } }));

    expect(entityOf(again, "per-sarah")?.fields["name"]).toEqual(["Sarah Chen"]);
  });
});

describe("folding a FieldSet event", () => {
  it("sets a field on an existing entity", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const state = applyEvent(created, aFieldSet({ field: "employer", value: "Acme" }));

    expect(entityOf(state, "per-sarah")?.fields["employer"]).toEqual(["Acme"]);
  });

  /** A `single` field supersedes rather than accumulates (ADR-0010). */
  it("supersedes the value a single field held", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const first = applyEvent(created, aFieldSet({ field: "employer", value: "Acme" }));
    const second = applyEvent(first, aFieldSet({ field: "employer", value: "Globex" }));

    expect(entityOf(second, "per-sarah")?.fields["employer"]).toEqual(["Globex"]);
  });

  it("advances the entity's version", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const state = applyEvent(created, aFieldSet({ field: "employer", value: "Acme" }));

    expect(entityOf(state, "per-sarah")?.version).toBe(2);
  });

  /**
   * An event against an entity that was never created is dropped rather than
   * creating one. A projection that invented entities from a partial log would
   * make a mid-rebuild read report entities the log does not contain.
   */
  it("drops an event against an entity that does not exist", () => {
    const state = applyEvent(emptyKnowledge(), aFieldSet({ field: "employer", value: "Acme" }));

    expect(entityOf(state, "per-sarah")).toBeUndefined();
  });
});

describe("folding a SetMemberAdded event", () => {
  it("adds a member to a set field", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const state = applyEvent(created, aSetMemberAdded({ field: "aliases", value: "Sarah C" }));

    expect(entityOf(state, "per-sarah")?.fields["aliases"]).toEqual(["Sarah C"]);
  });

  it("accumulates members rather than superseding them", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const first = applyEvent(created, aSetMemberAdded({ field: "aliases", value: "Sarah C" }));
    const second = applyEvent(first, aSetMemberAdded({ field: "aliases", value: "S. Chen" }));

    expect(entityOf(second, "per-sarah")?.fields["aliases"]).toEqual(["Sarah C", "S. Chen"]);
  });

  /** A set never holds one member twice, so a replayed event is a no-op. */
  it("does not add a member the set already holds", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const first = applyEvent(created, aSetMemberAdded({ field: "aliases", value: "Sarah C" }));
    const second = applyEvent(first, aSetMemberAdded({ field: "aliases", value: "Sarah C" }));

    expect(entityOf(second, "per-sarah")?.fields["aliases"]).toEqual(["Sarah C"]);
  });
});

describe("folding a FieldCleared event", () => {
  it("removes the field entirely", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const set = applyEvent(created, aFieldSet({ field: "employer", value: "Acme" }));
    const state = applyEvent(set, aFieldCleared({ field: "employer", because: "role" }));

    expect(entityOf(state, "per-sarah")?.fields["employer"]).toBeUndefined();
  });

  /**
   * Absent rather than empty: `entity.ts` treats an absent field as "nothing to
   * supersede" and an empty one as a value to compare against, and a cleared
   * field is the first of those.
   */
  it("leaves the field absent rather than empty", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const set = applyEvent(created, aFieldSet({ field: "employer", value: "Acme" }));
    const state = applyEvent(set, aFieldCleared({ field: "employer", because: "role" }));

    expect(entityOf(state, "per-sarah")?.fields).not.toHaveProperty("employer");
  });
});

describe("folding an EntitiesRelated event", () => {
  it("records the relation", () => {
    const state = applyEvent(emptyKnowledge(), anEntitiesRelated());

    expect(relationsIn(state)).toEqual([
      {
        name: "involves",
        from: { id: "proj-helios", type: "Project" },
        to: { id: "per-sarah", type: "Person" },
      },
    ]);
  });

  it("records one edge when the same relation is folded twice", () => {
    const first = applyEvent(emptyKnowledge(), anEntitiesRelated());
    const second = applyEvent(first, anEntitiesRelated());

    expect(relationsIn(second)).toHaveLength(1);
  });
});

describe("per-field provenance", () => {
  /**
   * `add.md` §7: every field names the event that last set it, and through it
   * the Proposal, the Capture, the model, and the confidence.
   */
  it("names the event that set a field", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const state = applyEvent(
      created,
      aFieldSet({ field: "employer", value: "Acme" }, { eventId: "evt-employer" }),
    );

    expect(provenanceOf(state, "per-sarah", "employer")?.eventId).toBe("evt-employer");
  });

  it("carries the model and confidence the event was recorded with", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const state = applyEvent(created, aFieldSet({ field: "employer", value: "Acme" }));

    const pointer = provenanceOf(state, "per-sarah", "employer");
    expect(pointer?.provenance.modelVersion).toBe("test-model-1");
    expect(pointer?.provenance.confidence).toBe(0.9);
  });

  it("moves the pointer to the event that superseded the value", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const first = applyEvent(
      created,
      aFieldSet({ field: "employer", value: "Acme" }, { eventId: "evt-first" }),
    );
    const second = applyEvent(
      first,
      aFieldSet({ field: "employer", value: "Globex" }, { eventId: "evt-second" }),
    );

    expect(provenanceOf(second, "per-sarah", "employer")?.eventId).toBe("evt-second");
  });

  /** A set field's pointer names the event that last added to it. */
  it("names the last event to add to a set field", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const first = applyEvent(
      created,
      aSetMemberAdded({ field: "aliases", value: "Sarah C" }, { eventId: "evt-first" }),
    );
    const second = applyEvent(
      first,
      aSetMemberAdded({ field: "aliases", value: "S. Chen" }, { eventId: "evt-second" }),
    );

    expect(provenanceOf(second, "per-sarah", "aliases")?.eventId).toBe("evt-second");
  });

  it("drops the pointer when the field is cleared", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const set = applyEvent(created, aFieldSet({ field: "employer", value: "Acme" }));
    const state = applyEvent(set, aFieldCleared({ field: "employer", because: "role" }));

    expect(provenanceOf(state, "per-sarah", "employer")).toBeUndefined();
  });

  /** ADR-0006: a user-confirmed fact is distinguishable from an auto-applied one. */
  it("distinguishes a human-confirmed field from an auto-applied one", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const state = applyEvent(
      created,
      aFieldSet(
        { field: "employer", value: "Acme" },
        { provenance: { isHumanConfirmed: true, confidence: null } },
      ),
    );

    expect(provenanceOf(state, "per-sarah", "employer")?.provenance.isHumanConfirmed).toBe(true);
  });

  it("gives the name set at creation a pointer to the creating event", () => {
    const state = applyEvent(emptyKnowledge(), anEntityCreated({ eventId: "evt-created" }));

    expect(provenanceOf(state, "per-sarah", "name")?.eventId).toBe("evt-created");
  });
});

describe("the fold as a value", () => {
  /** Folding never mutates, so a caller holding an earlier state still sees it. */
  it("leaves the state it was given untouched", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    applyEvent(created, aFieldSet({ field: "employer", value: "Acme" }));

    expect(entityOf(created, "per-sarah")?.fields["employer"]).toBeUndefined();
  });

  it("ignores an event type it does not know", () => {
    const created = applyEvent(emptyKnowledge(), anEntityCreated());
    const state = applyEvent(created, { ...anEntityCreated(), type: "SomethingElse" });

    expect(entityOf(state, "per-sarah")?.version).toBe(1);
  });
});
