import { CAPTURE_INGESTED, CAPTURE_INGESTED_VERSION } from "./capture-ingested.js";
import { identityUpcast, UpcastRegistry, type UpcastEntry } from "./upcast-registry.js";

/**
 * Every event version Otto has ever written, and the upcast carrying each
 * forward. **Rows are only ever added.** ADR-0011 calls the accumulation the
 * honest price of an immutable log — deleting a row here would strand every
 * event written at that version.
 *
 * The identity upcast registered below is the mechanism proving itself at
 * version 1: it does nothing, and the point is that the seam exists before
 * there is a second shape to need it.
 */
export const UPCASTS: readonly UpcastEntry[] = [
  { type: CAPTURE_INGESTED, fromVersion: 1, upcast: identityUpcast },
];

/** The version each event type's payload is currently written at. */
export const CURRENT_VERSIONS: ReadonlyMap<string, number> = new Map([
  [CAPTURE_INGESTED, CAPTURE_INGESTED_VERSION],
]);

/** The registry every read path upcasts through. */
export function createUpcastRegistry(): UpcastRegistry {
  const registry = new UpcastRegistry(UPCASTS);
  for (const [type, version] of CURRENT_VERSIONS) {
    registry.declareCurrentVersion(type, version);
  }
  return registry;
}
