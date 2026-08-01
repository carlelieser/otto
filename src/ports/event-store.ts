import type { DomainEvent, LogPosition, StoredEvent } from "../domain/events/domain-event.js";

/**
 * The executor's only write surface (`add.md` §9). Append, and read forward
 * from a position — nothing else, because nothing else is permitted to touch
 * the log.
 *
 * There is no update and no delete, and that absence is the point: `add.md`
 * §10 states there is no code path in Otto that updates or deletes a row in
 * `events`. A port that cannot express the operation is the first of the two
 * defences `qa.md` §4.1 asks for; SQLite triggers are the second, because a
 * test that the application declines to do something is weaker than a database
 * that will not permit it.
 */
export interface EventStore {
  /**
   * Appends events, returning them with the positions the log assigned.
   *
   * Appending an event whose `eventId` is already in the log is a no-op that
   * returns the stored event — the idempotency substrate Slice 1 builds on, and
   * what makes a retried pipeline run produce one event rather than two
   * (`runtime.md` §3).
   */
  append(events: readonly DomainEvent[]): Promise<readonly StoredEvent[]>;

  /** Events after `position`, in log order. `FROM_START` reads the whole log. */
  readForward(position: LogPosition, limit?: number): Promise<readonly StoredEvent[]>;

  /** The current version of an aggregate, or 0 if it has no events. */
  currentVersion(aggregateId: string): Promise<number>;
}

/** Reading forward from here yields the entire log. */
export const FROM_START: LogPosition = 0;
