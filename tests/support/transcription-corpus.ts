import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The labelled audio `qa.md` §6.4's proper-noun recall needs.
 *
 * Nothing upstream creates it, so it is this slice's work rather than an
 * assumed input — but recording the clips is human work and cannot be
 * delegated. The harness therefore reads an empty directory without failing:
 * the corpus arriving is a data change rather than a code change, and until it
 * does the measurement reports "0 clips" rather than a red build.
 */
export interface CorpusClip {
  readonly name: string;
  readonly audioPath: string;
  /** The proper nouns a transcript of this clip must contain. */
  readonly properNouns: readonly string[];
}

/** Where the clips and their sibling transcripts live. */
export const CORPUS_DIRECTORY = join(process.cwd(), "tests/fixtures/audio");

/**
 * Every clip with a sibling JSON transcript.
 *
 * A clip without one is skipped rather than failing: an unlabelled recording
 * has nothing to measure recall against, and a half-labelled corpus should
 * report on what it can.
 */
export function loadCorpus(directory: string = CORPUS_DIRECTORY): readonly CorpusClip[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(".wav"))
    .map((file) => toClip(directory, file))
    .filter((clip): clip is CorpusClip => clip !== null);
}

function toClip(directory: string, file: string): CorpusClip | null {
  const audioPath = join(directory, file);
  const labelPath = audioPath.replace(/\.wav$/, ".json");
  if (!existsSync(labelPath)) return null;
  const { properNouns } = JSON.parse(readFileSync(labelPath, "utf8")) as {
    properNouns?: readonly string[];
  };
  if (properNouns === undefined) return null;
  return { name: basename(file, ".wav"), audioPath, properNouns };
}

export interface RecallResult {
  readonly clips: number;
  readonly expected: number;
  readonly found: number;
  /** Expected proper nouns appearing exactly in their transcript, as a fraction. */
  readonly recall: number;
  readonly misses: readonly Miss[];
}

export interface Miss {
  readonly clip: string;
  readonly properNoun: string;
  readonly transcript: string;
}

/**
 * The fraction of expected proper nouns appearing exactly in the transcript.
 *
 * Exact match on purpose: "Sarah" transcribed as "Sara" is a resolution
 * problem, which is what §6.4 says makes name accuracy the metric that matters
 * rather than general WER. Case is ignored because capitalisation is not what
 * the resolver keys on, and normalisation would strip it anyway.
 */
export function measureRecall(
  transcripts: ReadonlyMap<string, string>,
  corpus: readonly CorpusClip[],
): RecallResult {
  const misses: Miss[] = [];
  let expected = 0;
  let found = 0;

  for (const clip of corpus) {
    const transcript = transcripts.get(clip.name) ?? "";
    for (const properNoun of clip.properNouns) {
      expected += 1;
      if (containsProperNoun(transcript, properNoun)) found += 1;
      else misses.push({ clip: clip.name, properNoun, transcript });
    }
  }

  return { clips: corpus.length, expected, found, recall: ratio(found, expected), misses };
}

/** Word-boundary match, so "Ross" is not found inside "across". */
function containsProperNoun(transcript: string, properNoun: string): boolean {
  const escaped = properNoun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "iu").test(transcript);
}

/** An empty corpus has no recall rather than a division by zero. */
function ratio(found: number, expected: number): number {
  return expected === 0 ? 0 : found / expected;
}
