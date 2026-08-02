import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyEvents, projectFromZero } from "../../src/domain/knowledge/project-entity.js";
import { emptyKnowledge } from "../../src/domain/knowledge/projected-state.js";
import { serialiseKnowledge } from "../../src/domain/knowledge/serialise-knowledge.js";
import { anEventLog } from "../support/log-arbitraries.js";

/**
 * **The load-bearing test of the entire projection design** (`qa.md` §7.1),
 * stated as a property because example-based projection tests sample this
 * badly: a handful of hand-written logs will not include the one where a field
 * is cleared before it was ever set.
 *
 * It runs against the pure fold rather than the database, which is what
 * `project-entity.ts` being free of I/O buys. The equivalent property against
 * SQLite is in `tests/projection/projection-worker.test.ts`; this one is where a
 * counterexample is legible, since a failure prints the log rather than a
 * database file.
 */

describe("rebuilding a projection from the log", () => {
  /** Dropping every projection and rebuilding produces byte-identical state. */
  it("produces byte-identical state on a second rebuild", () => {
    fc.assert(
      fc.property(anEventLog, (log) => {
        const first = serialiseKnowledge(projectFromZero(log));
        const second = serialiseKnowledge(projectFromZero(log));

        expect(second).toBe(first);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Partial-plus-catch-up equals a full rebuild (`qa.md` §8's correctness
   * checks). This is what makes the worker's incremental path trustworthy: a
   * projection that has been running since startup must equal one rebuilt from
   * scratch, or the two read paths disagree about what Otto knows.
   */
  it("equals a full rebuild when built in two passes", () => {
    fc.assert(
      fc.property(anEventLog, fc.nat(), (log, cut) => {
        const boundary = log.length === 0 ? 0 : cut % (log.length + 1);
        const partial = applyEvents(emptyKnowledge(), log.slice(0, boundary));
        const caughtUp = applyEvents(partial, log.slice(boundary));

        expect(serialiseKnowledge(caughtUp)).toBe(serialiseKnowledge(projectFromZero(log)));
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Catch-up in arbitrarily many chunks, not just two.
   *
   * The worker reads the log in batches whose boundaries it does not choose, so
   * "two passes" is the easy case rather than the real one.
   */
  it("equals a full rebuild however the log is chunked", () => {
    fc.assert(
      fc.property(anEventLog, fc.array(fc.nat({ max: 10 }), { maxLength: 8 }), (log, sizes) => {
        let state = emptyKnowledge();
        let offset = 0;
        for (const size of [...sizes, log.length]) {
          state = applyEvents(state, log.slice(offset, offset + size));
          offset += size;
        }
        state = applyEvents(state, log.slice(offset));

        expect(serialiseKnowledge(state)).toBe(serialiseKnowledge(projectFromZero(log)));
      }),
      { numRuns: 200 },
    );
  });
});

describe("provenance across any log", () => {
  /**
   * **For any entity in any projection state, no field lacks a provenance
   * pointer** (`qa.md` §7.5). The strong form of ADR-0006: a field whose origin
   * is unrecorded is unreconstructable later, so the property is that the case
   * never arises rather than that it is handled.
   */
  it("leaves no field without a pointer", () => {
    fc.assert(
      fc.property(anEventLog, (log) => {
        const state = projectFromZero(log);

        for (const entity of state.entities.values()) {
          const pointers = state.provenance.get(entity.id);
          for (const field of Object.keys(entity.fields)) {
            expect(pointers?.get(field)).toBeDefined();
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  /** And no pointer without a field, which is the same invariant from the other side. */
  it("leaves no pointer without a field", () => {
    fc.assert(
      fc.property(anEventLog, (log) => {
        const state = projectFromZero(log);

        for (const [entityId, pointers] of state.provenance) {
          const entity = state.entities.get(entityId);
          for (const field of pointers.keys()) {
            expect(entity?.fields[field]).toBeDefined();
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  /** Every pointer names an event the log actually contains. */
  it("names only events that are in the log", () => {
    fc.assert(
      fc.property(anEventLog, (log) => {
        const ids = new Set(log.map((event) => event.eventId));
        const state = projectFromZero(log);

        for (const pointers of state.provenance.values()) {
          for (const pointer of pointers.values()) {
            expect(ids.has(pointer.eventId)).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
