import { describe, expect, it } from "vitest";
import type { Entity } from "../../src/domain/knowledge/entity.js";
import type { Relation } from "../../src/domain/knowledge/relation.js";
import type { EntityType } from "../../src/domain/schema/entity-schema.js";
import type { ResolvedDate } from "../../src/domain/values/resolved-date.js";
import {
  V0_COEFFICIENTS,
  type SalienceCoefficients,
} from "../../src/inference/salience/coefficients.js";
import type { SalientEntity } from "../../src/inference/salience/salient-entity.js";
import { rankEntities, scoreEntity } from "../../src/inference/salience/score.js";

/**
 * The composite score, Person salience by association, and the property
 * `qa.md` §11 says "matters more than either": changing the rules and
 * recomputing produces a new ranking from the same log.
 */

const NOW = "2026-08-02T12:00:00.000Z";

describe("the composite score", () => {
  /**
   * `salience = recency + open_loop + imminence + attention_debt − dormancy`,
   * asserted as a whole from a fixture whose every term is known.
   */
  it("sums the named terms", () => {
    const task = salient(
      entity("Task", "t1", { status: "open" }, { due: date(daysAgo(-1)) }),
      daysAgo(15),
    );

    const { score, terms } = scoreEntity(task, NOW);

    expect(terms).toMatchObject({
      recency: 20,
      openLoop: 25,
      imminence: 30,
      attentionDebt: 0,
      dormancy: 0,
    });
    expect(score).toBe(75);
  });

  /** Legibility is the architectural requirement (ADR-0015), so terms survive the sum. */
  it("reports the terms that produced the score", () => {
    const project = salient(entity("Project", "p1", { status: "blocked" }), daysAgo(20));

    const { terms } = scoreEntity(project, NOW);

    expect(terms.recency).toBeCloseTo(40 / 3);
    expect(terms).toMatchObject({ openLoop: 25, attentionDebt: 15, dormancy: 0 });
  });

  it("holds a heavily-scoring entity to the top of the 0-100 scale", () => {
    const task = salient(
      entity("Task", "t1", { status: "open" }, { due: date(daysAgo(60)) }),
      daysAgo(30),
    );

    expect(scoreEntity(task, NOW).score).toBeLessThanOrEqual(100);
  });

  it("holds a closed, long-silent entity to 0 rather than going negative", () => {
    const done = salient(entity("Project", "p1", { status: "done" }), daysAgo(200));

    expect(scoreEntity(done, NOW).score).toBe(0);
  });
});

describe("Person salience by association", () => {
  /**
   * `salience.md` §2: a Person's score is the maximum salience of the Projects,
   * Tasks, and Events they relate to, plus their own recency. "People are
   * salient because something involving them is."
   */
  it("takes the maximum of what the Person relates to, plus their own recency", () => {
    const urgent = salient(
      entity("Project", "p1", { status: "active" }, { due: date(daysAgo(-1)) }),
      daysAgo(0),
    );
    const person = salient(entity("Person", "who"), daysAgo(15));

    const ranked = rankEntities([urgent, person], [involves("p1", "who")], NOW);

    // The Project scores 40 + 25 + 30 = 95; the Person adds their own recency of 20.
    expect(scoreOf(ranked, "who")).toBe(100);
    expect(termsOf(ranked, "who")).toMatchObject({ recency: 20, association: 95 });
  });

  /**
   * The maximum rather than a sum: someone attached to one urgent thing
   * outranks someone attached to six settled ones. Summing would make salience
   * a popularity count, which is a different and worse question.
   */
  it("does not accumulate across several associates", () => {
    const first = salient(entity("Project", "p1", { status: "active" }), daysAgo(30));
    const second = salient(entity("Project", "p2", { status: "active" }), daysAgo(30));
    const person = salient(entity("Person", "who"), daysAgo(30));

    const ranked = rankEntities(
      [first, second, person],
      [involves("p1", "who"), involves("p2", "who")],
      NOW,
    );

    // Each Project scores 25 from open_loop alone, and the Person borrows one 25.
    expect(scoreOf(ranked, "who")).toBe(25);
  });

  it("scores an unattached Person on their own recency alone", () => {
    const person = salient(entity("Person", "who"), daysAgo(15));

    const ranked = rankEntities([person], [], NOW);

    expect(scoreOf(ranked, "who")).toBe(20);
  });

  /** A Person carries no status and no date, so the other four terms say nothing. */
  it("scores no open_loop or imminence for a Person directly", () => {
    const person = salient(entity("Person", "who"), daysAgo(0));

    expect(termsOf(rankEntities([person], [], NOW), "who")).toMatchObject({
      openLoop: 0,
      imminence: 0,
      attentionDebt: 0,
      dormancy: 0,
    });
  });

  /** `salience.md` §2 names Projects, Tasks, and Events — not other Persons. */
  it("borrows nothing from another Person", () => {
    const other = salient(entity("Person", "other"), daysAgo(0));
    const person = salient(entity("Person", "who"), daysAgo(30));

    const ranked = rankEntities([person, other], [knows("other", "who")], NOW);

    expect(scoreOf(ranked, "who")).toBe(0);
  });
});

describe("the ranking", () => {
  it("orders highest first", () => {
    const dull = salient(entity("Idea", "i1", { status: "open" }), daysAgo(28));
    const urgent = salient(
      entity("Task", "t1", { status: "open" }, { due: date(daysAgo(-1)) }),
      daysAgo(0),
    );

    const ranked = rankEntities([dull, urgent], [], NOW);

    expect(ranked.map((score) => score.entityId)).toEqual(["t1", "i1"]);
  });

  /**
   * Two runs over one log must produce one order, or a v0-against-v1
   * comparison measures iteration order rather than rules.
   */
  it("breaks ties stably on id", () => {
    const tied = ["c", "a", "b"].map((id) =>
      salient(entity("Task", id, { status: "open" }), daysAgo(10)),
    );

    expect(rankEntities(tied, [], NOW).map((score) => score.entityId)).toEqual(["a", "b", "c"]);
  });
});

/**
 * **The architectural commitment** (`qa.md` §11, ADR-0015): salience is a
 * projection, so changing the rules and recomputing produces a new ranking from
 * the same log — a rebuild rather than a migration, with no accumulated state
 * to be wrong.
 *
 * This is what makes v0's expected replacement cheap, and it is the reason
 * every coefficient is an argument rather than a literal at its call site.
 */
describe("recomputation under new rules", () => {
  const log: readonly SalientEntity[] = [
    salient(entity("Task", "fresh", { status: "open" }), daysAgo(1)),
    salient(entity("Project", "stalled", { status: "blocked" }), daysAgo(60)),
  ];

  it("ranks the fresh Task first under v0", () => {
    expect(rankEntities(log, [], NOW).map((score) => score.entityId)).toEqual(["fresh", "stalled"]);
  });

  /**
   * `salience.md` §3 predicts recency dominating is "the most likely v0
   * complaint and the most likely first fix". Applying that fix is a
   * coefficient change and nothing else — no migration, no rewritten history.
   */
  it("reverses the ranking over the same entities when recency is weighted down", () => {
    const v1: SalienceCoefficients = {
      ...V0_COEFFICIENTS,
      recency: { atToday: 5, overDays: 30 },
      attentionDebt: { ...V0_COEFFICIENTS.attentionDebt, points: 40 },
    };

    const ranked = rankEntities(log, [], NOW, v1);

    expect(ranked.map((score) => score.entityId)).toEqual(["stalled", "fresh"]);
  });

  /** The same rules over the same input give the same answer, every time. */
  it("is deterministic", () => {
    expect(rankEntities(log, [], NOW)).toEqual(rankEntities(log, [], NOW));
  });
});

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000).toISOString();
}

function date(timestamp: string): ResolvedDate {
  return { timestamp, precision: "day", phrase: "a day" };
}

function entity(
  type: EntityType,
  id: string,
  statuses: Readonly<Record<string, string>> = {},
  dates: Readonly<Record<string, ResolvedDate>> = {},
): Entity {
  const fields = Object.fromEntries(
    [...Object.entries(statuses), ...Object.entries(dates)].map(([name, value]) => [name, [value]]),
  );
  return { id, type, fields: { name: ["a name"], ...fields }, version: 1 };
}

function salient(subject: Entity, lastMentionedAt: string): SalientEntity {
  return { entity: subject, lastMentionedAt, createdAt: lastMentionedAt };
}

function involves(projectId: string, personId: string): Relation {
  return {
    name: "involves",
    from: { id: projectId, type: "Project" },
    to: { id: personId, type: "Person" },
  };
}

function knows(fromId: string, toId: string): Relation {
  return {
    name: "knows",
    from: { id: fromId, type: "Person" },
    to: { id: toId, type: "Person" },
  };
}

function scoreOf(ranked: readonly { entityId: string; score: number }[], id: string): number {
  return ranked.find((score) => score.entityId === id)?.score ?? -1;
}

function termsOf(ranked: readonly { entityId: string; terms: unknown }[], id: string): unknown {
  return ranked.find((score) => score.entityId === id)?.terms;
}
