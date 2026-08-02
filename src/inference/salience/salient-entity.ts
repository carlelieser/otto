import type { Entity } from "../../domain/knowledge/entity.js";

/**
 * An entity and the two facts about it that live in the log rather than on it.
 *
 * `Entity` is what Otto believes; when it was last written about is a fact
 * about the log, and the fold does not carry it because nothing before salience
 * asked. Rather than widen `Entity` for one consumer in `inference/`, the
 * caller joins the two here — which also keeps the scorer a pure function of
 * its argument, so a term is testable from a literal with no projection behind
 * it (`qa.md` §11).
 *
 * Both timestamps are ISO 8601 UTC, matching everything else that crosses a
 * layer boundary in Otto.
 */
export interface SalientEntity {
  readonly entity: Entity;
  /**
   * When a Capture last mentioned this entity — the instant `recency` decays
   * from.
   *
   * The `recordedAt` of the most recent event against the entity, which is the
   * closest thing the log holds to "the user wrote about this". It is not the
   * same as the Capture's `sourceTimestamp`, and the difference is the pipeline
   * latency: seconds, against a term that decays over 30 days.
   */
  readonly lastMentionedAt: string;
  /** When the entity first appeared, for the weekly brief's "new this week". */
  readonly createdAt: string;
  /**
   * What the log did to this entity lately, for the weekly brief's change
   * sections (`salience.md` §4).
   *
   * The weekly brief is "about change rather than state — which is what the
   * event log makes cheap and a pile of notes does not", and change is not
   * visible on a folded entity: the fold's whole job is to reduce a history to
   * a current value. Counting is the caller's, because only the caller has the
   * log.
   *
   * Optional because the daily brief needs none of it, and a shape that
   * demanded a log scan for the cheaper of the two briefs would make the daily
   * path pay for the weekly one.
   */
  readonly activity?: EntityActivity;
}

/** How much the log changed one entity within a window. */
export interface EntityActivity {
  /** Events against this entity inside the window. */
  readonly changesThisWeek: number;
  /** Events in the week before the window, for "what didn't move". */
  readonly changesLastWeek: number;
  /** Whether any of this week's events changed the entity's `status`. */
  readonly statusChanged: boolean;
  /**
   * Events against this entity over its whole life.
   *
   * What separates a former regular from a name mentioned once, for the weekly
   * People section. It is a lifetime count rather than a windowed one because
   * the question it answers — "was this person previously frequent?" — is about
   * the past that the 60-day silence excludes.
   */
  readonly changesEver: number;
}

/** An entity the log did nothing to: what a caller supplying no activity means. */
export const NO_ACTIVITY: EntityActivity = {
  changesThisWeek: 0,
  changesLastWeek: 0,
  statusChanged: false,
  changesEver: 0,
};

/** This entity's activity, or the empty record when the caller supplied none. */
export function activityOf(entity: SalientEntity): EntityActivity {
  return entity.activity ?? NO_ACTIVITY;
}

/** The `status` value an entity carries, or `undefined` when it has no such field. */
export function statusOf(entity: Entity): string | undefined {
  const value = entity.fields["status"]?.[0];
  return typeof value === "string" ? value : undefined;
}
