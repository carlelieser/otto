import type { BriefKind, BriefSelection } from "../inference/salience/brief-selection.js";

/**
 * Where briefs are kept, and where the v0→v1 instrumentation is recorded
 * (`salience.md` §4, §5).
 *
 * **A brief is not regenerated once written.** It is a record of what mattered
 * on that day, and "rewriting history is not something Otto does anywhere else
 * either" — so `put` refuses a second brief for a date rather than replacing
 * one, and the refusal is visible in the return value rather than silent.
 *
 * Briefs are *surfaced* rather than pushed (PRD §5.7): the dashboard reads them
 * and a tray badge counts the unread ones. Nothing here notifies.
 */
export interface BriefStore {
  /**
   * Stores a brief, or returns the existing one when that date already has a
   * brief of that kind.
   *
   * Returns what is stored afterwards either way, so a caller cannot tell the
   * two apart by the shape of the answer and cannot accidentally treat a
   * refusal as a write. `wasStored` is what distinguishes them.
   */
  put(brief: StoredBrief): Promise<BriefWriteResult>;

  /** The most recent briefs of a kind, newest first. */
  recent(kind: BriefKind, limit?: number): Promise<readonly StoredBrief[]>;

  /** One brief by id, or `undefined` when there is none. */
  byId(briefId: string): Promise<StoredBrief | undefined>;

  /**
   * How many briefs the user has not opened — the tray badge (PRD §5.7).
   *
   * A count rather than a list, because the badge is the only signal briefs get
   * and it needs one number.
   */
  unreadCount(): Promise<number>;

  /** Marks a brief opened, which is what clears it from the badge. */
  markRead(briefId: string, readAt: string): Promise<void>;

  /**
   * Records that the user opened an entity, and whether a brief surfaced it
   * (`salience.md` §5).
   *
   * The precision-and-recall signal that replaces v0, "gathered passively with
   * no feedback UI". It is on this port rather than its own because the
   * question it answers is about briefs: which surfaced entities got opened,
   * and which opens no brief anticipated.
   */
  recordEntityOpened(open: EntityOpen): Promise<void>;

  /** What the instrumentation has gathered, for whoever measures v1. */
  attention(): Promise<AttentionSignal>;
}

/** A brief as stored: the selection, the prose, and when it covered what. */
export interface StoredBrief {
  /** Derived from the kind and the date it covers, so one date has one brief. */
  readonly briefId: string;
  readonly kind: BriefKind;
  /** The selection, kept whole so a stored brief records *why* each entity appeared. */
  readonly selection: BriefSelection;
  readonly prose: string;
  readonly provider: string;
  readonly modelVersion: string;
  readonly generatedAt: string;
  /** When the user opened it, or `null` while it is still unread. */
  readonly readAt: string | null;
}

/** Whether the write landed, and the brief that is stored either way. */
export interface BriefWriteResult {
  readonly brief: StoredBrief;
  /**
   * False when a brief already existed for that date and kind.
   *
   * The signal that a regeneration was refused. A caller that wanted to know
   * whether its composition was wasted asks this rather than comparing prose.
   */
  readonly wasStored: boolean;
}

/** One entity the user opened, and whether a brief had surfaced it. */
export interface EntityOpen {
  readonly entityId: string;
  readonly openedAt: string;
  /**
   * The brief that surfaced it, or `null` when none did.
   *
   * `null` is the interesting case: it is the recall signal, "which
   * high-salience entities the user opened without a brief having surfaced
   * them" (`salience.md` §5).
   */
  readonly briefId: string | null;
  /** The entity's salience when it was opened, so a miss can be weighed. */
  readonly salience: number;
}

/**
 * What the instrumentation gathered: precision and recall for the selection
 * rules (`salience.md` §5).
 *
 * Counts rather than rates, because the denominators are small enough early on
 * that a rate would read as more precise than it is — and because whoever
 * measures v1 will want to divide these differently than v0 guessed.
 */
export interface AttentionSignal {
  /** Entities surfaced by a brief, across every brief stored. */
  readonly surfaced: number;
  /** Of those, how many the user then opened. The precision signal. */
  readonly surfacedAndOpened: number;
  /** Opens of entities no brief surfaced. The recall signal. */
  readonly openedUnsurfaced: number;
  /**
   * The mean salience of the entities opened that no brief surfaced.
   *
   * The number that says whether the misses were near-misses or genuinely
   * unrelated: a high mean means the ranking was right and the caps were wrong,
   * a low one means the ranking itself missed something.
   */
  readonly meanUnsurfacedSalience: number;
}

/** How many briefs `recent` returns when the caller does not say. */
export const DEFAULT_BRIEF_LIMIT = 30;
