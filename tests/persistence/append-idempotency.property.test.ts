import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import { FROM_START, type EventStore } from "../../src/ports/event-store.js";
import { aCaptureIngested } from "../support/builders.js";

const createStore = (): EventStore => new SqliteEventStore(openDatabase());

/**
 * qa.md §3 puts property-based tests at the level "most likely to be skipped
 * and most likely to catch a Tier 0 bug". Idempotency under replay is a
 * statement of the form "for any sequence of appends…", which example-based
 * tests sample badly.
 */

/**
 * A well-formed event id. Ids are derived hashes in practice (`runtime.md` §3),
 * never arbitrary text, and a blank id is rejected before storage — so the
 * generator produces ids the system could actually mint.
 */
const anEventId = fc.hexaString({ minLength: 1, maxLength: 12 }).map((suffix) => `evt-${suffix}`);

/** Distinct event ids, so a generated batch's duplicates are deliberate. */
const eventIds = fc.uniqueArray(anEventId, { minLength: 1, maxLength: 8 });

describe("appending the same event twice", () => {
  it("produces one event, not two", async () => {
    await fc.assert(
      fc.asyncProperty(eventIds, fc.integer({ min: 2, max: 5 }), async (ids, replays) => {
        const store = createStore();
        const events = ids.map((eventId) => aCaptureIngested({ eventId }));
        for (let attempt = 0; attempt < replays; attempt += 1) await store.append(events);

        expect(await store.readForward(FROM_START)).toHaveLength(ids.length);
      }),
      { numRuns: 40 },
    );
  });

  it("leaves the log identical to a single-run log, however many replays", async () => {
    await fc.assert(
      fc.asyncProperty(eventIds, fc.integer({ min: 2, max: 4 }), async (ids, replays) => {
        const events = ids.map((eventId) => aCaptureIngested({ eventId }));
        const once = createStore();
        await once.append(events);

        const repeatedly = createStore();
        for (let attempt = 0; attempt < replays; attempt += 1) await repeatedly.append(events);

        expect(await repeatedly.readForward(FROM_START)).toEqual(
          await once.readForward(FROM_START),
        );
      }),
      { numRuns: 30 },
    );
  });

  it("returns the already-stored event when an append repeats", async () => {
    await fc.assert(
      fc.asyncProperty(anEventId, async (eventId) => {
        const store = createStore();
        const event = aCaptureIngested({ eventId });

        const [first] = await store.append([event]);
        const [second] = await store.append([event]);

        expect(second).toEqual(first);
      }),
      { numRuns: 40 },
    );
  });

  it("preserves append order regardless of replays", async () => {
    await fc.assert(
      fc.asyncProperty(eventIds, async (ids) => {
        const store = createStore();
        const events = ids.map((eventId) => aCaptureIngested({ eventId }));

        await store.append(events);
        await store.append(events);

        const stored = await store.readForward(FROM_START);
        expect(stored.map((event) => event.eventId)).toEqual(ids);
      }),
      { numRuns: 30 },
    );
  });
});
