import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  bandFor,
  thresholdsFor,
} from "../../src/inference/calibration/thresholds.js";
import { readSourceFiles } from "../boundaries/source-files.js";

/**
 * `qa.md` §5.3 and `triage.md` §2: `≥ 0.90` auto-applies, `0.50–0.90` reviews,
 * `< 0.50` discards.
 *
 * Off-by-one at a threshold boundary is the classic bug and costs nothing to
 * cover, so every edge is asserted exactly rather than approximately.
 */

const MODEL = { provider: "local", modelVersion: "qwen2.5-7b-instruct" } as const;

describe("the three bands", () => {
  it("auto-applies exactly at 0.90", () => {
    expect(bandFor(0.9, thresholdsFor(MODEL))).toBe("auto_apply");
  });

  it("reviews just below 0.90", () => {
    expect(bandFor(0.8999, thresholdsFor(MODEL))).toBe("needs_review");
  });

  it("reviews exactly at 0.50", () => {
    expect(bandFor(0.5, thresholdsFor(MODEL))).toBe("needs_review");
  });

  it("discards just below 0.50", () => {
    expect(bandFor(0.4999, thresholdsFor(MODEL))).toBe("discard");
  });
});

describe("keyed by provider and model version", () => {
  /**
   * ADR-0008 calls retrofitting this genuinely painful, which is why the
   * lookup takes the pair from the start even though every entry currently
   * resolves to the same initial values.
   */
  it("resolves an unmeasured model to the initial values", () => {
    expect(thresholdsFor({ provider: "anthropic", modelVersion: "claude-opus-5" })).toEqual(
      DEFAULT_THRESHOLDS,
    );
  });

  /**
   * The property that matters is that two models *can* differ, not that two
   * models *do* — the table ships with one row per measured model and there
   * are none yet. A supplied table stands in for the measured one.
   */
  it("gives two model versions different thresholds when the table says so", () => {
    const measured = new Map([
      ["local/strict", { autoApply: 0.95, discard: 0.6 }],
      ["local/loose", { autoApply: 0.8, discard: 0.3 }],
    ]);

    const strict = thresholdsFor({ provider: "local", modelVersion: "strict" }, measured);
    const loose = thresholdsFor({ provider: "local", modelVersion: "loose" }, measured);

    expect(bandFor(0.85, strict)).toBe("needs_review");
    expect(bandFor(0.85, loose)).toBe("auto_apply");
  });

  /**
   * `qa.md` §5.3: a Proposal is triaged against **its own** model's thresholds,
   * not the currently-active model's. The lookup takes the pair as an argument
   * and reads no ambient configuration, which is what makes that structural —
   * there is no "currently active model" for it to reach for.
   */
  it("reads no ambient current model", async () => {
    const source = await readFile(
      new URL("../../src/inference/calibration/thresholds.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/process\.env|activeModel|currentModel/);
  });
});

/**
 * `qa.md` §5.3 asks for this by name: thresholds are loaded as data from
 * `thresholds.ts`, not scattered as literals. Cheap insurance against the
 * second copy that drifts.
 */
describe("no threshold literals elsewhere in inference/", () => {
  const THRESHOLD_LITERALS = /(?<![\d.])(?:0\.90?|0\.50?)(?![\d])/;

  it("names 0.90 and 0.50 only in the threshold table", async () => {
    const offenders = (await readSourceFiles())
      .filter((file) => file.path.startsWith("inference/"))
      .filter((file) => file.path !== "inference/calibration/thresholds.ts")
      .filter((file) => THRESHOLD_LITERALS.test(withoutComments(file.text)))
      .map((file) => file.path);

    expect(offenders, "threshold literals outside the table").toEqual([]);
  });
});

/** Comments may quote the numbers; code may not. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
