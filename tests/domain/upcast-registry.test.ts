import { describe, expect, it } from "vitest";
import { CAPTURE_INGESTED } from "../../src/domain/events/capture-ingested.js";
import { createUpcastRegistry, UPCASTS } from "../../src/domain/events/event-versions.js";
import {
  identityUpcast,
  MissingUpcastError,
  UpcastRegistry,
  type UpcastEntry,
} from "../../src/domain/events/upcast-registry.js";
import { aCaptureIngested } from "../support/builders.js";

describe("every event version has an upcast path to the current shape", () => {
  // qa.md §4.5. The registry is the mechanism; today it carries one identity
  // upcast, which is the point — the seam exists before a second shape needs it.
  const registry = createUpcastRegistry();

  it.each(UPCASTS.map((entry) => [entry.type, entry.fromVersion] as const))(
    "%s at version %i reaches the current shape",
    (type, fromVersion) => {
      expect(registry.hasUpcastPath(type, fromVersion)).toBe(true);
    },
  );

  it("passes an event already at the current version through untouched", () => {
    const event = aCaptureIngested();
    expect(registry.upcastToCurrent(event)).toEqual(event);
  });

  it("refuses an event type it has never heard of", () => {
    const unknown = aCaptureIngested({ type: "NeverRegistered" });
    expect(() => registry.upcastToCurrent(unknown)).toThrow(MissingUpcastError);
  });

  it("refuses a version newer than the current shape", () => {
    const fromTheFuture = aCaptureIngested({ version: 99 });
    expect(() => registry.upcastToCurrent(fromTheFuture)).toThrow(/version 99/);
  });
});

describe("upcast functions are never deleted", () => {
  // ADR-0011 calls the accumulation the honest price of an immutable log.
  // This test is what keeps someone from quietly stopping paying it.
  it("still registers an upcast for every version ever written", () => {
    const registry = createUpcastRegistry();
    const registered = registry.registeredVersions();

    for (const entry of UPCASTS) {
      expect(registered).toContainEqual({ type: entry.type, fromVersion: entry.fromVersion });
    }
  });

  it("registers version 1 of CaptureIngested, the first event Otto ever wrote", () => {
    expect(UPCASTS).toContainEqual(
      expect.objectContaining({ type: CAPTURE_INGESTED, fromVersion: 1 }),
    );
  });
});

describe("the registry carries a payload across several versions", () => {
  // The mechanism has to work for a real chain, not only the identity case,
  // or version #2 discovers the seam was never load-bearing.
  const CHAINED = "ChainedEvent";

  /** Each step adds a marker, so the test can see which upcasts ran. */
  const CHAIN: UpcastEntry[] = [
    {
      type: CHAINED,
      fromVersion: 1,
      upcast: (payload) => ({ ...(payload as object), addedAtV2: true }),
    },
    {
      type: CHAINED,
      fromVersion: 2,
      upcast: (payload) => ({ ...(payload as object), addedAtV3: true }),
    },
  ];

  function chainedRegistry(): UpcastRegistry {
    const registry = new UpcastRegistry(CHAIN);
    registry.declareCurrentVersion(CHAINED, 3);
    return registry;
  }

  it("applies every upcast in turn from an old version", () => {
    const old = aCaptureIngested({ type: CHAINED, version: 1, payload: { original: true } });

    const upcast = chainedRegistry().upcastToCurrent(old);

    expect(upcast.payload).toEqual({ original: true, addedAtV2: true, addedAtV3: true });
    expect(upcast.version).toBe(3);
  });

  it("applies only the remaining upcasts from a middle version", () => {
    const middle = aCaptureIngested({ type: CHAINED, version: 2, payload: { original: true } });

    const upcast = chainedRegistry().upcastToCurrent(middle);

    expect(upcast.payload).toEqual({ original: true, addedAtV3: true });
  });

  it("reports a broken chain rather than silently skipping a version", () => {
    const gapped = new UpcastRegistry([{ type: CHAINED, fromVersion: 1, upcast: identityUpcast }]);
    gapped.declareCurrentVersion(CHAINED, 3);

    expect(gapped.hasUpcastPath(CHAINED, 1)).toBe(false);
    const old = aCaptureIngested({ type: CHAINED, version: 1, payload: {} });
    expect(() => gapped.upcastToCurrent(old)).toThrow(MissingUpcastError);
  });

  it("leaves provenance untouched while rewriting the payload", () => {
    const old = aCaptureIngested({ type: CHAINED, version: 1, payload: { original: true } });

    const upcast = chainedRegistry().upcastToCurrent(old);

    expect(upcast.provenance).toEqual(old.provenance);
  });
});
