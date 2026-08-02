import { describe, expect, it } from "vitest";
import type { Entity } from "../../src/domain/knowledge/entity.js";
import type { EntityType } from "../../src/domain/schema/entity-schema.js";
import type { ResolvedDate } from "../../src/domain/values/resolved-date.js";
import { V0_COEFFICIENTS } from "../../src/inference/salience/coefficients.js";
import type { SalientEntity } from "../../src/inference/salience/salient-entity.js";
import {
  attentionDebt,
  dormancy,
  imminence,
  openLoop,
  recency,
} from "../../src/inference/salience/terms.js";

/**
 * `qa.md` §11: given a fixture entity with a known mention date, status, and
 * due date, the score is a number, and **each term is tested in isolation**.
 *
 * Every case fixes `NOW` rather than reading a clock, which is what makes these
 * assertions exact instead of approximate. What is *not* tested here is whether
 * the coefficients are right — that is the product question `salience.md` §5
 * answers with instrumentation rather than with a test.
 */

const NOW = "2026-08-02T12:00:00.000Z";
const COEFFICIENTS = V0_COEFFICIENTS;

describe("recency", () => {
  it("scores the full 40 for a mention today", () => {
    expect(recency(mentioned(NOW), NOW, COEFFICIENTS)).toBe(40);
  });

  it("scores half at 15 days, halfway through the 30-day decay", () => {
    expect(recency(mentioned(daysAgo(15)), NOW, COEFFICIENTS)).toBe(20);
  });

  it("reaches 0 exactly at 30 days", () => {
    expect(recency(mentioned(daysAgo(30)), NOW, COEFFICIENTS)).toBe(0);
  });

  it("stays 0 beyond 30 days rather than going negative", () => {
    expect(recency(mentioned(daysAgo(90)), NOW, COEFFICIENTS)).toBe(0);
  });

  /** Clock skew between the log and the caller should not manufacture salience. */
  it("caps a future mention at the today value", () => {
    expect(recency(mentioned(daysAgo(-5)), NOW, COEFFICIENTS)).toBe(40);
  });
});

describe("open_loop", () => {
  it.each([
    ["active", 25],
    ["blocked", 25],
    ["paused", 0],
    ["done", 0],
    ["abandoned", 0],
  ])("scores a %s Project %d", (status, expected) => {
    expect(openLoop(entity("Project", { status }), COEFFICIENTS)).toBe(expected);
  });

  it.each([
    ["open", 25],
    ["done", 0],
    ["dropped", 0],
  ])("scores a %s Task %d", (status, expected) => {
    expect(openLoop(entity("Task", { status }), COEFFICIENTS)).toBe(expected);
  });

  /**
   * `salience.md` §2 names Projects and Tasks only. An Idea is by definition
   * the thing not yet committed to, so an open one is not an open *loop*.
   */
  it("scores an open Idea nothing", () => {
    expect(openLoop(entity("Idea", { status: "open" }), COEFFICIENTS)).toBe(0);
  });
});

describe("imminence", () => {
  it.each([
    [1, 30],
    [2, 30],
    [5, 20],
    [7, 20],
    [20, 10],
    [30, 10],
    [45, 0],
  ])("scores an Event %d days out at %d", (days, expected) => {
    const event = entity("Event", {}, { occurred_at: date(daysAgo(-days)) });
    expect(imminence(event, NOW, COEFFICIENTS)).toBe(expected);
  });

  /** "A missed deadline is more salient than an upcoming one, not less." */
  it("keeps an overdue open Task at the narrowest band", () => {
    const task = entity("Task", { status: "open" }, { due: date(daysAgo(10)) });
    expect(imminence(task, NOW, COEFFICIENTS)).toBe(30);
  });

  it("drops an overdue Task to 0 once it is closed", () => {
    const task = entity("Task", { status: "done" }, { due: date(daysAgo(10)) });
    expect(imminence(task, NOW, COEFFICIENTS)).toBe(0);
  });

  /** `schema.md` §8 excludes an unresolved date from everything time-ordered. */
  it("scores a relative_unresolved date nothing", () => {
    const task = entity(
      "Task",
      { status: "open" },
      {
        due: {
          timestamp: null,
          precision: "relative_unresolved",
          phrase: "when the contract lands",
        },
      },
    );
    expect(imminence(task, NOW, COEFFICIENTS)).toBe(0);
  });

  it("scores an entity carrying no date nothing", () => {
    expect(imminence(entity("Idea", { status: "open" }), NOW, COEFFICIENTS)).toBe(0);
  });
});

describe("attention_debt", () => {
  it("fires on a blocked Project unmentioned for 14 days", () => {
    const project = salient(entity("Project", { status: "blocked" }), daysAgo(14));
    expect(attentionDebt(project, NOW, COEFFICIENTS)).toBe(15);
  });

  it("does not fire on a blocked Project mentioned 13 days ago", () => {
    const project = salient(entity("Project", { status: "blocked" }), daysAgo(13));
    expect(attentionDebt(project, NOW, COEFFICIENTS)).toBe(0);
  });

  it("fires on an open Task unmentioned for 30 days", () => {
    const task = salient(entity("Task", { status: "open" }), daysAgo(30));
    expect(attentionDebt(task, NOW, COEFFICIENTS)).toBe(15);
  });

  it("does not fire on an open Task mentioned 29 days ago", () => {
    const task = salient(entity("Task", { status: "open" }), daysAgo(29));
    expect(attentionDebt(task, NOW, COEFFICIENTS)).toBe(0);
  });

  /** An active Project going quiet is not the same as a blocked one going quiet. */
  it("does not fire on a long-silent active Project", () => {
    const project = salient(entity("Project", { status: "active" }), daysAgo(200));
    expect(attentionDebt(project, NOW, COEFFICIENTS)).toBe(0);
  });

  it("does not fire on a closed Task however long it has been silent", () => {
    const task = salient(entity("Task", { status: "done" }), daysAgo(200));
    expect(attentionDebt(task, NOW, COEFFICIENTS)).toBe(0);
  });
});

describe("dormancy", () => {
  it.each(["done", "dropped", "abandoned"])("subtracts 20 from a %s entity", (status) => {
    expect(dormancy(entity("Project", { status }), NOW, COEFFICIENTS)).toBe(20);
  });

  it("subtracts nothing from an active Project", () => {
    expect(dormancy(entity("Project", { status: "active" }), NOW, COEFFICIENTS)).toBe(0);
  });

  it("subtracts 20 from an Event 8 days past with an outcome", () => {
    const past = entity("Event", {}, { occurred_at: date(daysAgo(8)) }, { outcome: "went well" });
    expect(dormancy(past, NOW, COEFFICIENTS)).toBe(20);
  });

  /**
   * Both halves are required. A past Event nobody wrote up is unfinished
   * business, and sinking it is how the meeting the user never recorded
   * disappears.
   */
  it("subtracts nothing from an Event 8 days past with no outcome", () => {
    const past = entity("Event", {}, { occurred_at: date(daysAgo(8)) });
    expect(dormancy(past, NOW, COEFFICIENTS)).toBe(0);
  });

  it("subtracts nothing from an Event 3 days past even with an outcome", () => {
    const recent = entity("Event", {}, { occurred_at: date(daysAgo(3)) }, { outcome: "went well" });
    expect(dormancy(recent, NOW, COEFFICIENTS)).toBe(0);
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
  statuses: Readonly<Record<string, string>> = {},
  dates: Readonly<Record<string, ResolvedDate>> = {},
  texts: Readonly<Record<string, string>> = {},
): Entity {
  const fields = Object.fromEntries(
    [...Object.entries(statuses), ...Object.entries(dates), ...Object.entries(texts)].map(
      ([name, value]) => [name, [value]],
    ),
  );
  return { id: `${type}-1`, type, fields: { name: ["a name"], ...fields }, version: 1 };
}

function salient(subject: Entity, lastMentionedAt: string): SalientEntity {
  return { entity: subject, lastMentionedAt, createdAt: lastMentionedAt };
}

function mentioned(lastMentionedAt: string): SalientEntity {
  return salient(entity("Project", { status: "active" }), lastMentionedAt);
}
