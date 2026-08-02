import type { BriefKind, BriefSection } from "../inference/salience/brief-selection.js";

/**
 * Selected entities in, short prose out (`salience.md` §4, ADD §8).
 *
 * One call per brief. It is given the selection as **structured data** rather
 * than raw notes, which is what makes the job possible at all: summarising a
 * week of prose is a much harder and much worse-grounded task than describing a
 * week of tracked change, and the whole write path exists to produce the
 * structure this reads.
 *
 * **It cannot introduce an entity that was not selected** — the same constraint
 * the differ places on extraction (ADD §5.4), for the same reason. Unlike
 * `Adjudicator`, the shape cannot enforce that here: prose is free text, so a
 * model can always write a name nobody gave it. The constraint is therefore
 * checked after the fact by `compose-brief.ts` rather than made structural, and
 * that difference is worth naming rather than hiding.
 *
 * ADR-0008's test holds: nothing in this signature mentions `temperature`,
 * `max_tokens`, or `messages[]`. Nothing in it knows an LLM is involved, which
 * is what lets a fully local runtime satisfy it.
 */
export interface BriefGenerator {
  /**
   * Short prose over `request.sections`.
   *
   * Throws when the model is unreachable or its output cannot be read. A brief
   * is not worth degrading into silence: the caller stores the selection
   * regardless (`compose-brief.ts`), so an outage costs the prose rather than
   * the record of what mattered that day.
   */
  generate(request: BriefRequest): Promise<GeneratedBrief>;
}

/** Everything the generator is given, and deliberately nothing more. */
export interface BriefRequest {
  readonly kind: BriefKind;
  /** The window the sections were selected over, so the prose can date itself. */
  readonly coversFrom: string;
  readonly coversTo: string;
  /**
   * The selected entities, grouped as the brief will read.
   *
   * Only sections that selected something, so the generator is never asked to
   * write around an empty heading — which is how padding gets in.
   */
  readonly sections: readonly BriefSection[];
}

/** The prose, and what wrote it. */
export interface GeneratedBrief {
  /**
   * The brief itself, as Markdown.
   *
   * **Patterns noticed across the week are left to the generator** with no
   * requirement to produce something (`salience.md` §4): a forced insight is
   * worse than none, so there is no separate "insights" field whose emptiness
   * would read as a failure to fill it.
   */
  readonly prose: string;
  readonly provider: string;
  readonly modelVersion: string;
}
