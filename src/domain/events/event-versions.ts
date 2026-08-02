import {
  CAPTURE_TRANSCRIPT_CORRECTED,
  CAPTURE_TRANSCRIPT_CORRECTED_VERSION,
} from "./capture-corrected.js";
import { CAPTURE_INGESTED, CAPTURE_INGESTED_VERSION } from "./capture-ingested.js";
import { KNOWLEDGE_EVENT_TYPES, KNOWLEDGE_EVENT_VERSION } from "./knowledge-events.js";
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
  { type: CAPTURE_TRANSCRIPT_CORRECTED, fromVersion: 1, upcast: identityUpcast },
  ...KNOWLEDGE_EVENT_TYPES.map((type) => ({
    type,
    fromVersion: KNOWLEDGE_EVENT_VERSION,
    upcast: identityUpcast,
  })),
];

/** The version each event type's payload is currently written at. */
export const CURRENT_VERSIONS: ReadonlyMap<string, number> = new Map([
  [CAPTURE_INGESTED, CAPTURE_INGESTED_VERSION],
  [CAPTURE_TRANSCRIPT_CORRECTED, CAPTURE_TRANSCRIPT_CORRECTED_VERSION],
  ...KNOWLEDGE_EVENT_TYPES.map((type) => [type, KNOWLEDGE_EVENT_VERSION] as const),
]);

/** The registry every read path upcasts through. */
export function createUpcastRegistry(): UpcastRegistry {
  const registry = new UpcastRegistry(UPCASTS);
  for (const [type, version] of CURRENT_VERSIONS) {
    registry.declareCurrentVersion(type, version);
  }
  return registry;
}
