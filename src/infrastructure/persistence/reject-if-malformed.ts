import { type DomainEvent, eventViolations } from "../../domain/events/domain-event.js";

/**
 * Events are validated before storage so the log never holds a malformed one.
 *
 * This is the store's guarantee rather than SQLite's, which is why it sits
 * beside the adapter instead of inside it: a missing provenance field is a
 * Tier 0 failure (`qa.md` §4.4), and it stays one however the log is stored.
 */
export function rejectIfMalformed(event: DomainEvent): DomainEvent {
  const violations = eventViolations(event);
  if (violations.length === 0) return event;

  const identity = `${event.eventId || "<no id>"} of type ${event.type || "<no type>"}`;
  throw new Error(`Cannot append event ${identity}: invalid or missing ${violations.join(", ")}`);
}
