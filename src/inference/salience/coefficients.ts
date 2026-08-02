/**
 * `salience.md` §2's numbers, in one place and passed as an argument.
 *
 * **This table is the whole of what v1 replaces** (ADR-0015). Salience is a
 * projection, so changing a number here and recomputing produces a new ranking
 * over the same log with no migration — that property is the entire reason
 * salience was made a projection, and a coefficient inlined at its call site
 * would be the thing that quietly breaks it.
 *
 * The numbers are wrong in the way `triage.md`'s thresholds are wrong: chosen
 * without usage data, expected to move, and instrumented rather than defended
 * (`salience.md` §5). What may not change is that a human can read a score and
 * say which term is responsible.
 */

/** The 0–100 scale scores are reported on (`salience.md` §2). */
export const SALIENCE_SCALE = { minimum: 0, maximum: 100 } as const;

/** One band of a step function: everything within `days` scores `points`. */
export interface Step {
  readonly days: number;
  readonly points: number;
}

/**
 * Every coefficient the five terms read, named as `salience.md` §2 names them.
 *
 * A single record rather than five exported constants, because the recompute
 * property is about swapping the *set*: a caller supplying its own table is how
 * a v1 ranking is compared against v0's over one log.
 */
export interface SalienceCoefficients {
  /** Linear decay from `atToday` to 0 over `overDays` (`salience.md` §2). */
  readonly recency: { readonly atToday: number; readonly overDays: number };
  /** Awarded to an active or blocked Project, and to an open Task. */
  readonly openLoop: number;
  /**
   * Bands for a date in the future, narrowest first.
   *
   * Ordered so the first match wins, which is what makes "within 2 days" score
   * 30 rather than also matching the 7-day band and taking whichever the
   * iteration order happened to reach last.
   */
  readonly imminence: readonly Step[];
  /** A past-dated open item keeps the narrowest band until it is closed. */
  readonly overdue: number;
  /** What a blocked Project and a stale open Task each earn, with their silences. */
  readonly attentionDebt: {
    readonly points: number;
    readonly blockedProjectSilentDays: number;
    readonly openTaskSilentDays: number;
  };
  /** Subtracted from anything closed, and from an Event past with an outcome. */
  readonly dormancy: { readonly points: number; readonly settledEventDays: number };
}

/**
 * The v0 table, transcribed from `salience.md` §2.
 *
 * `tests/inference/salience-terms.test.ts` reads the document and checks this
 * transcription, the same arrangement `entity-schema.ts` uses against
 * `schema.md`: the specification names itself the authority, and an authority
 * nothing checks against is a comment.
 */
export const V0_COEFFICIENTS: SalienceCoefficients = {
  recency: { atToday: 40, overDays: 30 },
  openLoop: 25,
  imminence: [
    { days: 2, points: 30 },
    { days: 7, points: 20 },
    { days: 30, points: 10 },
  ],
  overdue: 30,
  attentionDebt: { points: 15, blockedProjectSilentDays: 14, openTaskSilentDays: 30 },
  dormancy: { points: 20, settledEventDays: 7 },
};
