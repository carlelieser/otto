import { type Provenance, provenanceViolations } from "../values/provenance.js";
import { isNonEmptyText } from "../values/text.js";

/**
 * A record that knowledge did change: past tense, immutable, never refused,
 * never deleted, and never carrying a figure about how likely it is to be
 * correct (CONTEXT.md) — that belongs to provenance, as machinery.
 *
 * Every event carries a type and a version so payload shapes are never changed
 * in place — a new shape is a new version with an upcast from the old one
 * (ADR-0011). The version field costs nothing at event type #1 and is a log
 * migration at event type #20, which is the one migration an immutable log
 * does not permit.
 */
export interface DomainEvent<Payload = unknown> {
  /** Unique per event, derived so that replaying an append is a no-op. */
  readonly eventId: string;
  readonly type: string;
  /** The payload shape's version, resolved through the upcast registry at read time. */
  readonly version: number;
  readonly aggregate: AggregateRef;
  readonly payload: Payload;
  readonly provenance: Provenance;
  /** When the change was recorded, ISO 8601. */
  readonly recordedAt: string;
}

/**
 * The aggregate an event targets, stamped with the version it was computed
 * against. Optimistic concurrency uses this: a Proposal that sat in the review
 * queue while its target changed fails its version check at apply time
 * (`add.md` §5.6). The staleness *behaviour* is Slice 4's; the stamp has to be
 * on the event from the first one.
 */
export interface AggregateRef {
  readonly type: string;
  readonly id: string;
  /** The aggregate's version before this event; 0 for the first event of an aggregate. */
  readonly version: number;
}

/** An event's position in the log, assigned by the store on append. */
export type LogPosition = number;

/** An event as stored, carrying the position the log assigned it. */
export interface StoredEvent<Payload = unknown> extends DomainEvent<Payload> {
  readonly position: LogPosition;
}

/**
 * Why an event is not well-formed, or empty if it is.
 *
 * `qa.md` §4.4 makes a missing provenance field a Tier 0 failure rather than a
 * cosmetic one, so this is checked before an event reaches the log rather than
 * discovered when someone asks where a fact came from.
 */
export function eventViolations(event: DomainEvent): readonly string[] {
  return [
    ...missingEventFields(event),
    ...aggregateViolations(event.aggregate),
    ...provenanceViolations(event.provenance).map((field) => `provenance.${field}`),
  ];
}

function missingEventFields(event: DomainEvent): string[] {
  const violations: string[] = [];
  if (!isNonEmptyText(event.eventId)) violations.push("eventId");
  if (!isNonEmptyText(event.type)) violations.push("type");
  if (!isNonEmptyText(event.recordedAt)) violations.push("recordedAt");
  if (!Number.isInteger(event.version) || event.version < 1) violations.push("version");
  return violations;
}

function aggregateViolations(aggregate: AggregateRef): string[] {
  const violations: string[] = [];
  if (!isNonEmptyText(aggregate?.type)) violations.push("aggregate.type");
  if (!isNonEmptyText(aggregate?.id)) violations.push("aggregate.id");
  if (!Number.isInteger(aggregate?.version) || aggregate.version < 0) {
    violations.push("aggregate.version");
  }
  return violations;
}
