import type { BriefKind } from "../../inference/salience/brief-selection.js";
import {
  DEFAULT_BRIEF_LIMIT,
  type AttentionSignal,
  type BriefStore,
  type StoredBrief,
} from "../../ports/brief-store.js";
import { selectedIds } from "../../inference/salience/brief-selection.js";

/**
 * The read side of briefs: what is waiting, what it said, and recording that
 * the user looked (PRD §5.7, `salience.md` §5).
 *
 * Briefs are **surfaced rather than pushed**. Nothing here notifies; the
 * dashboard reads and the tray shows a count. That is the whole of the delivery
 * mechanism in MVP, and customisation and delivery outside the app are
 * explicitly post-MVP (PRD §7.2).
 */
export class BriefReads {
  readonly #briefs: BriefStore;

  constructor(briefs: BriefStore) {
    this.#briefs = briefs;
  }

  /** The most recent briefs of a kind, newest first. */
  async recent(
    kind: BriefKind,
    limit: number = DEFAULT_BRIEF_LIMIT,
  ): Promise<readonly StoredBrief[]> {
    return this.#briefs.recent(kind, limit);
  }

  /** One brief, or `undefined` when there is none by that id. */
  async byId(briefId: string): Promise<StoredBrief | undefined> {
    return this.#briefs.byId(briefId);
  }

  /**
   * How many briefs are waiting — the tray badge, and the only signal briefs
   * get (PRD §5.7, this slice's "not in scope").
   */
  async unreadCount(): Promise<number> {
    return this.#briefs.unreadCount();
  }

  /** Opening a brief marks it read, which is what clears the badge. */
  async open(briefId: string, at: string): Promise<StoredBrief | undefined> {
    await this.#briefs.markRead(briefId, at);
    return this.#briefs.byId(briefId);
  }

  /**
   * Records that the user opened an entity, crediting the brief that surfaced
   * it when one did (`salience.md` §5).
   *
   * **The whole feedback mechanism, and it has no UI.** Whether a brief gets
   * credit is decided here by looking at what the brief actually selected
   * rather than by trusting a caller's claim — a dashboard that passed the
   * currently-open brief's id would credit it for every entity the user reached
   * from that screen, which is precisely the number that would make v0 look
   * better than it is.
   */
  async recordEntityOpened(open: RecordedOpen): Promise<void> {
    await this.#briefs.recordEntityOpened({
      entityId: open.entityId,
      openedAt: open.openedAt,
      briefId: await this.#surfacingBrief(open),
      salience: open.salience,
    });
  }

  /** The brief the user came from, but only if it really listed this entity. */
  async #surfacingBrief(open: RecordedOpen): Promise<string | null> {
    if (open.fromBriefId === undefined) return null;
    const brief = await this.#briefs.byId(open.fromBriefId);
    if (brief === undefined) return null;
    return selectedIds(brief.selection).has(open.entityId) ? brief.briefId : null;
  }

  /** What the instrumentation has gathered, for whoever measures v1. */
  async attention(): Promise<AttentionSignal> {
    return this.#briefs.attention();
  }
}

/** An entity the user opened, and where they came from. */
export interface RecordedOpen {
  readonly entityId: string;
  readonly openedAt: string;
  /** The entity's salience at the time, so an unsurfaced open can be weighed. */
  readonly salience: number;
  /**
   * The brief the user was reading, when they were reading one.
   *
   * A claim rather than a fact: it is checked against what that brief actually
   * selected before any credit is given.
   */
  readonly fromBriefId?: string;
}
