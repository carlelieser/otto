import type { Entity } from "../../domain/knowledge/entity.js";
import type { EntityType } from "../../domain/schema/entity-schema.js";
import type { Adjudication, AdjudicationRequest } from "../../ports/adjudicator.js";
import { type Candidate, type CandidateReads, generateCandidates } from "./candidate-generation.js";
import { type Resolution, resolveFromScores } from "./resolve-mention.js";
import { type ScoredCandidate, type ScoringContext, scoreCandidates } from "./scoring.js";

/**
 * One Mention, resolved: candidates generated, scored, and adjudicated only if
 * the scorer left the case genuinely ambiguous (`add.md` §5.3).
 *
 * The three steps in order, with the adjudicator on a branch rather than on the
 * path — it is invoked for the ambiguous minority, which is what keeps
 * resolution "mostly not an LLM" (ADR-0007).
 *
 * **Adjudication changes which candidate, never how confident.** When it runs,
 * the confidence is still the scorer's margin between the top two candidates
 * (`triage.md` §1) — an adjudicated pick among near-identical candidates is not
 * made confident by having been adjudicated. That is the single most
 * misimplementable sentence in this slice, and it is one line below.
 */

/** Everything resolving one Mention needs, beyond the reads. */
export interface MentionToResolve {
  readonly text: string;
  readonly entityType: EntityType;
  /** The Capture's text, which the adjudicator reads the mention in context of. */
  readonly noteText: string;
  readonly capturedAt: string;
  /** Absent when the embedder was unavailable; generation degrades rather than fails. */
  readonly embedding?: Float32Array;
  /** Entity ids already resolved from this Capture, for the co-occurrence feature. */
  readonly coResolvedIds: readonly string[];
}

/** The reads and the adjudicator, injected — `inference/` reaches for nothing. */
export interface ResolutionDependencies {
  readonly reads: CandidateReads;
  /** Related ids per candidate, for co-occurrence. Injected for the same reason. */
  relatedIdsFor(entityIds: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>>;
  adjudicate(request: AdjudicationRequest): Promise<Adjudication>;
}

/** How many candidates the adjudicator is ever shown (`add.md` §9). */
const ADJUDICATION_SHORTLIST = 4;

/** What resolving one Mention produced. */
export interface ResolvedMention {
  readonly resolution: Resolution;
  readonly wasAdjudicated: boolean;
  readonly candidateCount: number;
}

/** Candidates, scores, a decision, and adjudication only where it is warranted. */
export async function resolveMention(
  mention: MentionToResolve,
  dependencies: ResolutionDependencies,
): Promise<ResolvedMention> {
  const candidates = await generateCandidates(requestFor(mention), dependencies.reads);
  const scored = await scoreAll(candidates, mention, dependencies);
  const resolution = resolveFromScores(scored);

  if (!resolution.isAmbiguous) {
    return { resolution, wasAdjudicated: false, candidateCount: candidates.length };
  }
  return adjudicated(resolution, scored, mention, dependencies);
}

function requestFor(mention: MentionToResolve) {
  const { text, entityType, embedding } = mention;
  return {
    mentionText: text,
    entityType,
    ...(embedding === undefined ? {} : { embedding }),
  };
}

async function scoreAll(
  candidates: readonly Candidate[],
  mention: MentionToResolve,
  dependencies: ResolutionDependencies,
): Promise<readonly ScoredCandidate[]> {
  const relatedIds = await dependencies.relatedIdsFor(
    candidates.map((candidate) => candidate.entity.id),
  );
  return scoreCandidates(candidates, contextFor(mention, relatedIds));
}

function contextFor(
  mention: MentionToResolve,
  relatedIds: ReadonlyMap<string, readonly string[]>,
): ScoringContext {
  return {
    mentionText: mention.text,
    entityType: mention.entityType,
    coResolvedIds: mention.coResolvedIds,
    relatedIds,
    capturedAt: mention.capturedAt,
  };
}

/**
 * The ambiguous case: the adjudicator picks among the top few, and **the
 * confidence does not move**.
 *
 * A decline is taken as "none of these" with candidates rejected — the outcome
 * that goes to review rather than auto-applying, which is the right home for a
 * case the scorer could not settle and a model declined to settle either.
 */
async function adjudicated(
  resolution: Resolution,
  scored: readonly ScoredCandidate[],
  mention: MentionToResolve,
  dependencies: ResolutionDependencies,
): Promise<ResolvedMention> {
  const shortlist = scored.slice(0, ADJUDICATION_SHORTLIST);
  const { chosenIndex } = await dependencies.adjudicate(requestFrom(mention, shortlist));

  return {
    // `confidence` is carried through untouched: an adjudicated pick among
    // near-identical candidates is not made confident by having been
    // adjudicated (`triage.md` §1).
    resolution: withChoice(resolution, shortlist, chosenIndex),
    wasAdjudicated: true,
    candidateCount: scored.length,
  };
}

/** The note, the mention, and the shortlist — rendered without entity ids. */
function requestFrom(
  mention: MentionToResolve,
  shortlist: readonly ScoredCandidate[],
): AdjudicationRequest {
  return {
    noteText: mention.noteText,
    mentionText: mention.text,
    entityType: mention.entityType,
    candidates: shortlist.map(({ candidate }) => summarise(candidate)),
  };
}

function withChoice(
  resolution: Resolution,
  shortlist: readonly ScoredCandidate[],
  chosenIndex: number | null,
): Resolution {
  const chosen = chosenIndex === null ? undefined : shortlist[chosenIndex];
  if (chosen === undefined) {
    return { ...resolution, outcome: "rejected_candidates", entityId: null };
  }
  return { ...resolution, outcome: "matched", entityId: chosen.candidate.entity.id };
}

/** A candidate as the adjudicator sees it — a name and a summary, never an id. */
function summarise(candidate: Candidate): { name: string; summary: string } {
  return { name: displayName(candidate.entity), summary: summaryOf(candidate.entity) };
}

function displayName(entity: Entity): string {
  const [name] = entity.fields["name"] ?? [];
  return typeof name === "string" ? name : "(unnamed)";
}

function summaryOf(entity: Entity): string {
  const [summary] = entity.fields["summary"] ?? [];
  return typeof summary === "string" ? summary : `A ${entity.type} Otto knows nothing else about.`;
}
