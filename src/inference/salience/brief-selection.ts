import type { SalienceScore } from "./score.js";

/**
 * What selection produces and generation consumes (`salience.md` §4).
 *
 * **Selection precedes generation** (ADD §8), and these shapes are the seam:
 * everything the generator may name is here, and the constraint that it names
 * nothing else is checkable because this is a closed list rather than a prompt.
 *
 * A section is a heading, the entities under it, and the reason they qualified.
 * Sections that select nothing are omitted rather than emitted empty — "a brief
 * that manufactures content on a quiet day teaches the user to skim" — so an
 * empty `sections` array is the legitimate quiet-day output rather than a
 * failure.
 */

/** Which cadence a brief covers. */
export const BRIEF_KINDS = ["daily", "weekly"] as const;

export type BriefKind = (typeof BRIEF_KINDS)[number];

/** One selected entity, with the score that selected it. */
export interface SelectedEntity {
  readonly entityId: string;
  readonly name: string;
  readonly entityType: string;
  /** The score at selection time, kept so the brief records why this appeared. */
  readonly salience: SalienceScore;
  /**
   * The fields the generator is allowed to see, already reduced to strings.
   *
   * Reduced here rather than handed the whole `Entity`, because the generator
   * is an LLM and every field it sees is a field it can quote. Passing the
   * projection wholesale would put provenance and internal ids in a prompt that
   * has no use for them.
   */
  readonly facts: Readonly<Record<string, string>>;
}

/** One section of a brief: a heading and what qualified for it. */
export interface BriefSection {
  readonly heading: string;
  readonly entities: readonly SelectedEntity[];
}

/**
 * The selection a brief is generated from.
 *
 * `coversFrom`/`coversTo` bound the window the sections were selected over,
 * which is what makes a stored brief re-readable months later as a record of
 * what mattered *then* rather than a query that would answer differently now.
 */
export interface BriefSelection {
  readonly kind: BriefKind;
  readonly coversFrom: string;
  readonly coversTo: string;
  /** Only the sections that selected something. */
  readonly sections: readonly BriefSection[];
}

/** Whether the window selected nothing at all — a legitimate output. */
export function isQuiet(selection: BriefSelection): boolean {
  return selection.sections.length === 0;
}

/**
 * Every entity id the selection names, across all sections.
 *
 * **The constraint the generator is checked against** (ADD §8): a brief may not
 * introduce an entity that was not selected, the same rule the differ places on
 * extraction. One entity can appear in two sections, so this is a set.
 */
export function selectedIds(selection: BriefSelection): ReadonlySet<string> {
  return new Set(
    selection.sections.flatMap((section) => section.entities.map((entity) => entity.entityId)),
  );
}

/** A section built from `entities`, or nothing when it selected nothing. */
export function sectionOf(
  heading: string,
  entities: readonly SelectedEntity[],
  cap: number,
): readonly BriefSection[] {
  const capped = entities.slice(0, cap);
  return capped.length === 0 ? [] : [{ heading, entities: capped }];
}

/**
 * The sections as plain Markdown: a heading and a list of names.
 *
 * Shared by the two places that render a selection without a model — the
 * fallback when generated prose is refused, and the in-memory generator. They
 * are the same rendering of the same shape, and two copies would be two things
 * that must agree about what a brief looks like with no model behind it.
 *
 * It names only selected entities, so output from here cannot fail the
 * no-new-entities check that the fallback exists to satisfy.
 */
export function renderSections(sections: readonly BriefSection[]): string {
  return sections
    .map((section) => {
      const names = section.entities.map((entity) => `- ${entity.name}`);
      return [`## ${section.heading}`, ...names].join("\n");
    })
    .join("\n\n");
}
