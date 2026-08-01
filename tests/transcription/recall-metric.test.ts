import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CorpusClip, loadCorpus, measureRecall } from "../support/transcription-corpus.js";

/**
 * The metric and the corpus loader, tested without any audio.
 *
 * The measurement itself needs a whisper build and recorded clips, and lives in
 * `transcription-recall.local.test.ts`. What is asserted here is that the
 * scoring is right — otherwise the number that measurement produces means
 * nothing, and it is the number Slices 6 and 9 are measured against.
 */
let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function aClip(name: string, properNouns: readonly string[]): CorpusClip {
  return { name, audioPath: `${name}.wav`, properNouns };
}

describe("proper-noun recall scores exact name matches", () => {
  it("counts a name that appears in the transcript", () => {
    const result = measureRecall(new Map([["clip", "Coffee with Sarah about Helios."]]), [
      aClip("clip", ["Sarah", "Helios"]),
    ]);

    expect(result).toMatchObject({ expected: 2, found: 2, recall: 1 });
  });

  /**
   * The case §6.4 is about: a near-miss is a miss, because "Sara" resolves to a
   * different entity than "Sarah" does.
   */
  it("counts a near-miss as a miss", () => {
    const result = measureRecall(new Map([["clip", "Coffee with Sara."]]), [
      aClip("clip", ["Sarah"]),
    ]);

    expect(result.found).toBe(0);
    expect(result.misses).toEqual([
      { clip: "clip", properNoun: "Sarah", transcript: "Coffee with Sara." },
    ]);
  });

  it("ignores case, which the resolver does not key on", () => {
    const result = measureRecall(new Map([["clip", "coffee with sarah"]]), [
      aClip("clip", ["Sarah"]),
    ]);

    expect(result.recall).toBe(1);
  });

  /** A name inside a longer word is not that name. */
  it("matches on word boundaries", () => {
    const result = measureRecall(new Map([["clip", "walked across the room"]]), [
      aClip("clip", ["Ross"]),
    ]);

    expect(result.found).toBe(0);
  });

  it("scores a partially correct transcript proportionally", () => {
    const result = measureRecall(new Map([["clip", "Coffee with Sarah about Helios."]]), [
      aClip("clip", ["Sarah", "Helios", "Okonkwo"]),
    ]);

    expect(result).toMatchObject({ expected: 3, found: 2 });
    expect(result.recall).toBeCloseTo(2 / 3);
  });

  it("treats a clip with no transcript as all misses", () => {
    const result = measureRecall(new Map(), [aClip("clip", ["Sarah"])]);

    expect(result).toMatchObject({ expected: 1, found: 0, recall: 0 });
  });

  it("reports zero rather than dividing by zero on an empty corpus", () => {
    expect(measureRecall(new Map(), [])).toMatchObject({ clips: 0, expected: 0, recall: 0 });
  });
});

/**
 * The corpus arriving must be a data change rather than a code change, so the
 * loader tolerates a directory that does not exist yet.
 */
describe("the corpus loader reads what is there", () => {
  function aCorpusDirectory(): string {
    directory = mkdtempSync(join(tmpdir(), "otto-corpus-"));
    return directory;
  }

  it("reports no clips for a directory that does not exist", () => {
    expect(loadCorpus("/no/such/corpus")).toEqual([]);
  });

  it("reports no clips for an empty directory", () => {
    expect(loadCorpus(aCorpusDirectory())).toEqual([]);
  });

  it("loads a clip with its sibling transcript", () => {
    const corpus = aCorpusDirectory();
    writeFileSync(join(corpus, "one.wav"), "");
    writeFileSync(join(corpus, "one.json"), JSON.stringify({ properNouns: ["Sarah"] }));

    expect(loadCorpus(corpus)).toEqual([
      { name: "one", audioPath: join(corpus, "one.wav"), properNouns: ["Sarah"] },
    ]);
  });

  it("skips a clip with no transcript rather than failing", () => {
    const corpus = aCorpusDirectory();
    writeFileSync(join(corpus, "unlabelled.wav"), "");

    expect(loadCorpus(corpus)).toEqual([]);
  });
});
