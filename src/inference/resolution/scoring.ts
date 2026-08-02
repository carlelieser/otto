import type { Entity } from "../../domain/knowledge/entity.js";
import type { EntityType } from "../../domain/schema/entity-schema.js";
import type { Candidate } from "./candidate-generation.js";
import { nameSimilarity } from "./name-similarity.js";

/**
 * Ranking candidates on features Otto controls, and **the place
 * `p(resolution)` comes from** (`add.md` §5.3, `triage.md` §1).
 *
 * Never the model's self-report, which ADR-0006 argues is a token distribution
 * rather than a probability. Every feature here is something Otto computed and
 * can explain, which is what makes the number arguable — and a confidence
 * nobody can argue with is a confidence nobody can improve.
 *
 * The features are `add.md` §5.3's four: name similarity, co-occurrence with
 * other entities resolved in the same Capture, recency of contact, and type
 * agreement.
 */

/** What the scorer knows about the Mention and the Capture it came from. */
export interface ScoringContext {
  readonly mentionText: string;
  readonly entityType: EntityType;
  /**
   * Entity ids already resolved from this same Capture, and the ids each of
   * them is related to.
   *
   * The co-occurrence feature reads this: a Sarah who is on the Helios project
   * is the likelier Sarah in a note that also mentions Helios. It is evidence
   * for *resolution* and it writes nothing — the `knows` relation is recorded
   * only when a note says so, never inferred from co-occurrence
   * (`schema.md` §6), and this is the exact seam where that bug would enter.
   */
  readonly coResolvedIds: readonly string[];
  /** Related-entity ids per candidate, keyed by candidate entity id. */
  readonly relatedIds: ReadonlyMap<string, readonly string[]>;
  /** The Capture's timestamp, which recency is measured back from. ISO 8601. */
  readonly capturedAt: string;
}

/**
 * The weight each feature carries, as data rather than as literals in the
 * scoring expression.
 *
 * Legible on purpose, for ADR-0015's reason about salience: a score a human
 * cannot read and argue with is not improvable at this data volume. These are
 * initial values chosen to be defensible rather than measured — the eval set is
 * what replaces them, and it can only do that if they are in one place.
 *
 * Name similarity dominates because it is the highest-precision evidence
 * available; co-occurrence is worth less than a name but more than recency,
 * since a shared project is real evidence and "mentioned lately" is weak.
 *
 * ## Why name similarity alone can carry a match
 *
 * The three other features are **corroborating** rather than necessary, and the
 * weights have to say so. A Person Otto has met once has no co-occurrence, no
 * recorded contact, and one generation source — so if the corroborators were
 * needed to clear the match floor, the commonest correct case in the product
 * ("the note names someone by their exact recorded name") would score barely
 * above the bar and be sent to the adjudicator. That is a model call on a case
 * with no ambiguity in it, and it would be the *majority* of calls.
 *
 * So `nameSimilarity` alone reaches 0.75, comfortably past the 0.55 floor, and
 * the corroborators move a candidate within the band rather than into it. The
 * asymmetry ADR-0009 asks for is preserved by the floors rather than by
 * starving the dominant feature: a *weak* name match still cannot be carried
 * over the floor by recency and co-occurrence together, since 0.25 is less than
 * the 0.55 the floor requires.
 */
export const FEATURE_WEIGHTS = {
  nameSimilarity: 0.75,
  sourceAgreement: 0.1,
  coOccurrence: 0.1,
  recency: 0.05,
} as const;

/** How near in time counts as recent contact. Beyond this the feature is 0. */
const RECENCY_HORIZON_DAYS = 90;

/** A candidate with its computed score and the features behind it. */
export interface ScoredCandidate {
  readonly candidate: Candidate;
  /** The weighted sum of the features, in [0, 1]. */
  readonly score: number;
  readonly features: Features;
}

/** Each feature's contribution before weighting, every one in [0, 1]. */
export interface Features {
  readonly nameSimilarity: number;
  readonly sourceAgreement: number;
  readonly coOccurrence: number;
  readonly recency: number;
}

/** Every candidate scored, best first. */
export function scoreCandidates(
  candidates: readonly Candidate[],
  context: ScoringContext,
): readonly ScoredCandidate[] {
  return candidates
    .map((candidate) => scoreOne(candidate, context))
    .sort((left, right) => right.score - left.score);
}

function scoreOne(candidate: Candidate, context: ScoringContext): ScoredCandidate {
  const features = featuresOf(candidate, context);
  return { candidate, score: weightedSum(features), features };
}

function featuresOf(candidate: Candidate, context: ScoringContext): Features {
  return {
    nameSimilarity: similarityOf(candidate.entity, context.mentionText),
    sourceAgreement: agreementOf(candidate),
    coOccurrence: coOccurrenceOf(candidate.entity, context),
    recency: recencyOf(candidate.entity, context.capturedAt),
  };
}

function weightedSum(features: Features): number {
  const total =
    features.nameSimilarity * FEATURE_WEIGHTS.nameSimilarity +
    features.sourceAgreement * FEATURE_WEIGHTS.sourceAgreement +
    features.coOccurrence * FEATURE_WEIGHTS.coOccurrence +
    features.recency * FEATURE_WEIGHTS.recency;
  return clampToUnit(total);
}

/**
 * How alike the Mention's text is to the candidate's best-matching name.
 *
 * Aliases count, and the best of them wins: an entity recorded as "Sarah Chen"
 * with the alias "Sar" is a perfect match for a note saying "Sar", and scoring
 * only the display name would rank it below an unrelated "Sara".
 */
function similarityOf(entity: Entity, mentionText: string): number {
  const names = [...(entity.fields["name"] ?? []), ...(entity.fields["aliases"] ?? [])];
  const similarities = names
    .filter((name): name is string => typeof name === "string")
    .map((name) => nameSimilarity(mentionText, name));
  return similarities.length === 0 ? 0 : Math.max(...similarities);
}

/**
 * How many of the three generation sources found this candidate, normalised.
 *
 * Agreement between independent signals is evidence in its own right: an entity
 * an exact match, a fuzzy match, and a vector search all found is a stronger
 * candidate than one a single fuzzy hit produced.
 */
function agreementOf(candidate: Candidate): number {
  return candidate.sources.length / TOTAL_SOURCES;
}

const TOTAL_SOURCES = 3;

/**
 * Whether this candidate is related to anything else the same Capture resolved.
 *
 * A Sarah on the Helios project is the likelier Sarah in a note that also
 * mentions Helios. **This reads relations and writes none** — inferring a
 * `knows` edge from two people appearing in one note is the bug `schema.md` §6
 * names, and it would enter here or nowhere.
 */
function coOccurrenceOf(entity: Entity, context: ScoringContext): number {
  const related = new Set(context.relatedIds.get(entity.id) ?? []);
  if (related.size === 0 || context.coResolvedIds.length === 0) return 0;
  const overlap = context.coResolvedIds.filter((id) => related.has(id)).length;
  return clampToUnit(overlap / context.coResolvedIds.length);
}

/**
 * How recently this entity was in contact, decaying to 0 at the horizon.
 *
 * Reads `last_contact_at`, which is derived by projection and never proposed
 * (`schema.md` §3). An entity with no recorded contact scores 0 rather than
 * being penalised further — absent is not the same as long ago, and a Person
 * created last week has no contact history by construction.
 */
function recencyOf(entity: Entity, capturedAt: string): number {
  const lastContact = entity.fields["last_contact_at"]?.[0];
  if (lastContact === undefined || typeof lastContact === "string") return 0;
  if (lastContact.timestamp === null) return 0;

  const elapsedDays = daysBetween(lastContact.timestamp, capturedAt);
  if (Number.isNaN(elapsedDays) || elapsedDays < 0) return 0;
  return clampToUnit(1 - elapsedDays / RECENCY_HORIZON_DAYS);
}

function daysBetween(earlier: string, later: string): number {
  const milliseconds = Date.parse(later) - Date.parse(earlier);
  return milliseconds / (24 * 60 * 60 * 1000);
}

function clampToUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}
