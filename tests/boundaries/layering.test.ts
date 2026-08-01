import { describe, expect, it } from "vitest";
import {
  findConfidenceMentions,
  findViolations,
  IMPORT_RULES,
  type LayeringRule,
} from "./layering-rules.js";
import { readSourceFiles, readViolatingFixture, type SourceFile } from "./source-files.js";

const [INFERENCE_RULE, DOMAIN_RULE, INFRASTRUCTURE_RULE] = IMPORT_RULES as [
  LayeringRule,
  LayeringRule,
  LayeringRule,
];

const realTree: readonly SourceFile[] = await readSourceFiles();

/** A fixture placed where the rule it violates applies. */
async function fixtureAt(fixtureName: string, pretendPath: string): Promise<SourceFile[]> {
  return [await readViolatingFixture(fixtureName, pretendPath)];
}

describe("the real tree honours every layering rule", () => {
  it.each(IMPORT_RULES.map((rule) => [rule.name, rule] as const))("%s", (_name, rule) => {
    expect(findViolations(rule, realTree)).toEqual([]);
  });

  it("no module under domain/ mentions confidence", () => {
    expect(findConfidenceMentions(realTree)).toEqual([]);
  });

  it("scans a tree that actually has source in it", () => {
    expect(realTree.length).toBeGreaterThan(0);
  });
});

describe("each rule fails on a deliberately-violating fixture", () => {
  it("catches inference/ importing the event store port", async () => {
    const files = await fixtureAt("inference-imports-port.ts.fixture", "inference/resolution/x.ts");
    expect(findViolations(INFERENCE_RULE, files)).toHaveLength(1);
  });

  it("catches inference/ importing application/", async () => {
    const files = await fixtureAt(
      "inference-imports-application.ts.fixture",
      "inference/proposal/x.ts",
    );
    expect(findViolations(INFERENCE_RULE, files)).toHaveLength(1);
  });

  it("catches domain/ importing outward", async () => {
    const files = await fixtureAt("domain-imports-outward.ts.fixture", "domain/events/x.ts");
    expect(findViolations(DOMAIN_RULE, files)).toHaveLength(1);
  });

  it("catches a non-root module importing infrastructure/", async () => {
    const files = await fixtureAt(
      "non-root-imports-infrastructure.ts.fixture",
      "application/pipeline/x.ts",
    );
    expect(findViolations(INFRASTRUCTURE_RULE, files)).toHaveLength(1);
  });

  it("catches domain/ mentioning confidence", async () => {
    const files = await fixtureAt("domain-mentions-confidence.ts.fixture", "domain/values/x.ts");
    expect(findConfidenceMentions(files)).toEqual(["domain/values/x.ts"]);
  });

  it("catches a knowledge type carrying a confidence", async () => {
    // The violation rule 4 is actually about: a number attached to something
    // past-tense, which ADR-0002 says means two concepts got merged.
    const files = await fixtureAt(
      "domain-mentions-confidence.ts.fixture",
      "domain/knowledge/person.ts",
    );
    expect(findConfidenceMentions(files)).toHaveLength(1);
  });

  it("catches an application policy reading a confidence", async () => {
    // "The domain policy is asked about a kind of change, never about a
    // number" — add.md §3.
    const files = await fixtureAt(
      "domain-mentions-confidence.ts.fixture",
      "domain/policies/application-policy.ts",
    );
    expect(findConfidenceMentions(files)).toHaveLength(1);
  });
});

describe("the rules do not fire on legitimate code", () => {
  it("permits the composition root to import infrastructure/", () => {
    const root: SourceFile[] = [
      { path: "composition-root.ts", text: `import { X } from "./infrastructure/x.js";` },
    ];
    expect(findViolations(INFRASTRUCTURE_RULE, root)).toEqual([]);
  });

  it("permits domain/ to import its own siblings", () => {
    const sibling: SourceFile[] = [
      { path: "domain/events/x.ts", text: `import { Y } from "../values/provenance.js";` },
    ];
    expect(findViolations(DOMAIN_RULE, sibling)).toEqual([]);
  });

  it("permits the provenance record to name a Confidence", () => {
    // add.md §10 requires the event row to carry "the confidence at the time"
    // as part of its provenance. Provenance is a record about machinery, which
    // is what rule 4 exists to keep separate from knowledge — not an instance
    // of it.
    const provenance: SourceFile[] = [
      { path: "domain/values/provenance.ts", text: `readonly confidence: number | null;` },
    ];
    expect(findConfidenceMentions(provenance)).toEqual([]);
  });

  it("exempts provenance and nothing else", () => {
    // The exemption is one file wide. A sibling in the same directory saying
    // the same thing is still a violation, so the carve-out cannot widen by
    // someone putting a confidence next to it.
    const neighbour: SourceFile[] = [
      { path: "domain/values/entity-ref.ts", text: `readonly confidence: number;` },
    ];
    expect(findConfidenceMentions(neighbour)).toEqual(["domain/values/entity-ref.ts"]);
  });

  it("permits an infrastructure module to import its siblings", () => {
    const sibling: SourceFile[] = [
      {
        path: "infrastructure/persistence/sqlite-event-store.ts",
        text: `import { x } from "./event-row.js";`,
      },
    ];
    expect(findViolations(INFRASTRUCTURE_RULE, sibling)).toEqual([]);
  });

  it("still catches application/ reaching into infrastructure/", () => {
    // The sibling exemption above must not weaken the rule it exempts from.
    const reachingIn: SourceFile[] = [
      {
        path: "application/pipeline/x.ts",
        text: `import { x } from "../../infrastructure/persistence/sqlite-event-store.js";`,
      },
    ];
    expect(findViolations(INFRASTRUCTURE_RULE, reachingIn)).toHaveLength(1);
  });

  it("permits inference/ to import domain/", () => {
    const allowed: SourceFile[] = [
      { path: "inference/proposal/x.ts", text: `import { Y } from "../../domain/events/x.js";` },
    ];
    expect(findViolations(INFERENCE_RULE, allowed)).toEqual([]);
  });
});
