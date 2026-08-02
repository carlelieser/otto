import type { Entity } from "../../src/domain/knowledge/entity.js";
import type { EntityType } from "../../src/domain/schema/entity-schema.js";
import type { Mention } from "../../src/ports/extractor.js";
import type { Candidate } from "../../src/ports/entity-repository.js";
import type { ResolvedDate } from "../../src/domain/values/resolved-date.js";

/**
 * Builders for the knowledge model, kept apart from `builders.ts` because they
 * belong to a different half of the system: that file builds the write path's
 * Captures and Commands, this one builds what resolution reads and the differ
 * compares against.
 *
 * Every builder takes overrides and defaults the rest, so a test states only
 * what it is about — a fixture where the interesting value is buried among
 * plausible noise is a fixture whose failure message says nothing.
 */

/** A stored Person named Sarah. Override only what a test is about. */
export function anEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: "per-sarah",
    type: "Person",
    fields: { name: ["Sarah Chen"] },
    version: 1,
    ...overrides,
  };
}

/** A stored entity of `type`, with a name and an id derived from it. */
export function anEntityOfType(type: EntityType, overrides: Partial<Entity> = {}): Entity {
  return anEntity({ id: `${type.toLowerCase()}-1`, type, ...overrides });
}

/**
 * A Mention as extraction produced it, claiming nothing beyond its text.
 *
 * `confidence` is `p(extraction)` — the model's self-report, which has no
 * scorer behind it (`triage.md` §1). It is deliberately not 1.0 here: a fixture
 * carrying a perfect self-report would let a blend of the two confidences pass
 * unnoticed, since multiplying by one changes nothing.
 */
export function aMention(overrides: Partial<Mention> = {}): Mention {
  return {
    text: "Sarah",
    entityType: "Person",
    fields: [],
    confidence: 0.8,
    ...overrides,
  };
}

/** A candidate entity as generation produced it, with the reason it was found. */
export function aCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    entity: anEntity(),
    sources: ["alias"],
    ...overrides,
  };
}

/** A resolved date at day precision. Override the precision to test the others. */
export function aResolvedDate(overrides: Partial<ResolvedDate> = {}): ResolvedDate {
  return {
    timestamp: "2026-08-04T00:00:00.000Z",
    precision: "day",
    phrase: "Tuesday",
    ...overrides,
  };
}
