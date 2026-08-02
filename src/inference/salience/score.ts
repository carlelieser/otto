import type { Relation } from "../../domain/knowledge/relation.js";
import { SALIENCE_SCALE, V0_COEFFICIENTS, type SalienceCoefficients } from "./coefficients.js";
import type { SalientEntity } from "./salient-entity.js";
import { attentionDebt, dormancy, imminence, openLoop, recency } from "./terms.js";

/**
 * The v0 score, and the ranking over a whole knowledge base (`salience.md` §2).
 *
 * ```
 * salience = recency + open_loop + imminence + attention_debt − dormancy
 * ```
 *
 * **Nothing here writes.** `inference/` computes and returns (ADR-0003), and
 * salience in particular is a projection recomputed from the log rather than
 * accumulated state (ADR-0015) — which is what lets a coefficient change
 * produce a new ranking over the same history with no migration behind it.
 */

/** A score with the five terms that produced it, kept rather than summed away. */
export interface SalienceScore {
  readonly entityId: string;
  /** The sum, clamped to 0–100. */
  readonly score: number;
  /**
   * What each term contributed, so a reader can say which one is wrong.
   *
   * This is legibility made mechanical (ADR-0015). A score arrives at the UI
   * with its own explanation attached, and the instrumentation that replaces v0
   * can report *why* something was surfaced rather than only that it was.
   */
  readonly terms: SalienceTerms;
}

/** Each named term's contribution, `dormancy` positive as the amount subtracted. */
export interface SalienceTerms {
  readonly recency: number;
  readonly openLoop: number;
  readonly imminence: number;
  readonly attentionDebt: number;
  readonly dormancy: number;
  /**
   * What a Person borrowed from the strongest thing they relate to, and 0 for
   * everything else (`salience.md` §2).
   *
   * A sixth named term rather than a second shape, because a Person's score is
   * as legible as any other and hiding the borrowed part would leave a reader
   * with a number none of the five terms explains. It is not in the formula
   * §2 states because §2 states the formula for the four scored types and gives
   * Persons their own rule; this is that rule, made readable the same way.
   */
  readonly association: number;
}

/**
 * One entity's score at an instant.
 *
 * `now` is a parameter rather than a clock read, which is what makes this
 * assertable from a fixture: the same entity and the same instant produce the
 * same number on any machine on any day.
 */
export function scoreEntity(
  entity: SalientEntity,
  now: string,
  coefficients: SalienceCoefficients = V0_COEFFICIENTS,
): SalienceScore {
  const terms: SalienceTerms = {
    recency: recency(entity, now, coefficients),
    openLoop: openLoop(entity.entity, coefficients),
    imminence: imminence(entity.entity, now, coefficients),
    attentionDebt: attentionDebt(entity, now, coefficients),
    dormancy: dormancy(entity.entity, now, coefficients),
    association: 0,
  };
  return { entityId: entity.entity.id, score: clamp(sum(terms)), terms };
}

/**
 * Every entity scored, Persons resolved by association, ranked highest first.
 *
 * The whole ranking rather than one entity at a time, because Person salience
 * is not a function of the Person alone — it needs the scores of everything
 * they relate to, so the two passes below are forced by the rule rather than
 * chosen for speed.
 *
 * Ties break on entity id. Arbitrary, but *stable*: two runs over one log
 * produce the same order, which is what makes a v0-against-v1 comparison a
 * comparison of rules rather than of iteration order.
 */
export function rankEntities(
  entities: readonly SalientEntity[],
  relations: readonly Relation[],
  now: string,
  coefficients: SalienceCoefficients = V0_COEFFICIENTS,
): readonly SalienceScore[] {
  const direct = entities.map((entity) => scoreEntity(entity, now, coefficients));
  const byId = new Map(direct.map((score) => [score.entityId, score]));
  const associated = entities.map((entity) =>
    entity.entity.type === "Person"
      ? scorePerson(entity, byId, relations, now, coefficients)
      : (byId.get(entity.entity.id) as SalienceScore),
  );
  return [...associated].sort(byScoreThenId);
}

/**
 * **A Person's score is the maximum salience of what they relate to, plus their
 * own `recency`** (`salience.md` §2).
 *
 * "People are rarely salient on their own — they are salient because something
 * involving them is." So the other four terms are not computed for a Person at
 * all: they carry no status, no date, and no open loop, and a Person scored
 * directly would rank purely on how recently they were named.
 *
 * The maximum rather than a sum, so someone attached to one urgent Project
 * outranks someone attached to six settled ones. Summing would make salience a
 * popularity count, which is a different and worse question.
 */
function scorePerson(
  person: SalientEntity,
  scores: ReadonlyMap<string, SalienceScore>,
  relations: readonly Relation[],
  now: string,
  coefficients: SalienceCoefficients,
): SalienceScore {
  const terms: SalienceTerms = {
    ...NO_TERMS,
    recency: recency(person, now, coefficients),
    association: strongestAssociate(person.entity.id, scores, relations),
  };
  return { entityId: person.entity.id, score: clamp(sum(terms)), terms };
}

/** The highest score among the Projects, Tasks, and Events this Person touches. */
function strongestAssociate(
  personId: string,
  scores: ReadonlyMap<string, SalienceScore>,
  relations: readonly Relation[],
): number {
  const associated = relations
    .filter((relation) => touches(relation, personId))
    .map((relation) => otherEnd(relation, personId))
    .filter((end) => ASSOCIABLE_TYPES.includes(end.type))
    .map((end) => scores.get(end.id)?.score ?? 0);
  return associated.length === 0 ? 0 : Math.max(...associated);
}

/** The three types a Person borrows salience from (`salience.md` §2). */
const ASSOCIABLE_TYPES: readonly string[] = ["Project", "Task", "Event"];

function touches(relation: Relation, id: string): boolean {
  return relation.from.id === id || relation.to.id === id;
}

function otherEnd(relation: Relation, id: string): { readonly id: string; readonly type: string } {
  return relation.from.id === id ? relation.to : relation.from;
}

const NO_TERMS: SalienceTerms = {
  recency: 0,
  openLoop: 0,
  imminence: 0,
  attentionDebt: 0,
  dormancy: 0,
  association: 0,
};

/** The positive terms less the one negative one. */
function sum(terms: SalienceTerms): number {
  const positive = terms.recency + terms.openLoop + terms.imminence + terms.attentionDebt;
  return positive + terms.association - terms.dormancy;
}

/**
 * The score held to 0–100.
 *
 * The terms cannot currently exceed 100 — 40 + 25 + 30 + 15 is 110, so they
 * can — and a negative sum is reachable by dormancy alone. Clamping here rather
 * than trusting the arithmetic means a coefficient change cannot silently take
 * the scale with it, which is the change v0 exists to invite.
 */
function clamp(score: number): number {
  return Math.min(SALIENCE_SCALE.maximum, Math.max(SALIENCE_SCALE.minimum, score));
}

/** Highest score first, ties broken on id so the order is stable across runs. */
function byScoreThenId(left: SalienceScore, right: SalienceScore): number {
  return right.score - left.score || left.entityId.localeCompare(right.entityId);
}
