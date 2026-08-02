/**
 * Text in, vector out. Used for candidate generation, not user-facing search
 * (`add.md` §9).
 *
 * **Local always, no cloud option** (`runtime.md` §2, `stack.md` §5). This is
 * the one inference port with no opt-in cloud adapter, and the reason is a
 * cost/benefit rather than a principle: the quality bar is "narrow thousands of
 * entities to a handful," a 130 MB local model clears it, and sending every
 * entity the user knows to a provider for that job is a privacy cost with no
 * return.
 *
 * PRD §7.2 defers semantic search, so nothing here serves a user-visible
 * feature. If that changes, the bar changes with it and this port's adapter is
 * the thing to re-examine — not this signature, which knows only that text
 * becomes a vector.
 */
export interface Embedder {
  /**
   * The vector for `text`.
   *
   * Throws when the model is unavailable. A caller cannot distinguish a zero
   * vector from a failed call, and candidate generation degrading silently to
   * "no vector candidates" would look like a resolution that found nothing —
   * which is a decision, not an outage.
   */
  embed(text: string): Promise<Float32Array>;

  /**
   * Vectors for several texts, in the order given.
   *
   * Present because the projection embeds every changed entity after a rebuild
   * and a per-text round trip over thousands of entities is the difference
   * between a batch that finishes and one that does not. Nothing about this
   * signature says how the batching happens.
   */
  embedAll(texts: readonly string[]): Promise<readonly Float32Array[]>;

  /** How many components its vectors carry. The column width the index expects. */
  readonly dimensions: number;

  /** The model, exactly as it names itself. Recorded alongside what it produced. */
  readonly modelVersion: string;
}
