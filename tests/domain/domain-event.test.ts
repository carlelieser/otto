import { describe, expect, it } from "vitest";
import { eventViolations } from "../../src/domain/events/domain-event.js";
import { provenanceViolations } from "../../src/domain/values/provenance.js";
import { aCaptureIngested, aProvenance } from "../support/builders.js";

describe("event well-formedness", () => {
  it("accepts an event carrying type, version, aggregate, and full provenance", () => {
    expect(eventViolations(aCaptureIngested())).toEqual([]);
  });

  it.each([
    ["eventId", { eventId: "" }],
    ["type", { type: "" }],
    ["recordedAt", { recordedAt: "" }],
    ["version", { version: 0 }],
  ])("rejects an event missing %s", (field, override) => {
    expect(eventViolations(aCaptureIngested(override))).toContain(field);
  });

  it("rejects an event whose aggregate is not fully identified", () => {
    const event = aCaptureIngested({ aggregate: { type: "", id: "", version: -1 } });
    expect(eventViolations(event)).toEqual(
      expect.arrayContaining(["aggregate.type", "aggregate.id", "aggregate.version"]),
    );
  });

  it("accepts aggregate version 0, the first event of an aggregate", () => {
    const event = aCaptureIngested({ aggregate: { type: "Capture", id: "cap-1", version: 0 } });
    expect(eventViolations(event)).toEqual([]);
  });
});

describe("provenance is Tier 0, not cosmetic", () => {
  // qa.md §4.4: a missing provenance field is a Tier 0 failure. ADR-0006 notes
  // provenance not recorded at write time is unreconstructable later.
  it.each(["captureId", "provider", "modelVersion"])("rejects provenance missing %s", (field) => {
    const event = aCaptureIngested({ provenance: aProvenance({ [field]: "" }) });
    expect(eventViolations(event)).toContain(`provenance.${field}`);
  });

  it("rejects a Confidence outside [0, 1]", () => {
    const tooHigh = aProvenance({ confidence: 1.5 });
    expect(provenanceViolations(tooHigh)).toContain("confidence");
  });

  it("permits a null Confidence, meaning no inference was involved", () => {
    expect(provenanceViolations(aProvenance({ confidence: null }))).toEqual([]);
  });

  it("records whether a human confirmed the change", () => {
    const event = aCaptureIngested({ provenance: aProvenance({ isHumanConfirmed: true }) });
    expect(event.provenance.isHumanConfirmed).toBe(true);
    expect(eventViolations(event)).toEqual([]);
  });
});

describe("no event carries a Confidence as a property of knowledge", () => {
  // qa.md §4.4. The provenance records what the machinery reported at the time
  // of inference; the knowledge does not carry a figure of its own. The
  // distinction is subtle enough to erode, hence an explicit test.
  it("keeps the inference figure on provenance, never on the payload", () => {
    const event = aCaptureIngested();
    expect(Object.keys(event.payload as object)).not.toContain("confidence");
    expect(event.provenance).toHaveProperty("confidence");
  });

  it("has no confidence-shaped key anywhere outside provenance", () => {
    const { provenance: _provenance, ...knowledge } = aCaptureIngested();
    const serialised = JSON.stringify(knowledge);
    expect(serialised).not.toMatch(/confidence/i);
  });
});
