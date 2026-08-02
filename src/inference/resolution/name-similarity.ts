/**
 * How alike two names are, as a number in [0, 1].
 *
 * This is a resolution feature, not a general string utility, and it lives in
 * `inference/` because that is what it is for: the scorer reads it, and the
 * fuzzy candidate source thresholds on it. The specific failure it exists to
 * catch is the one `runtime.md` §2 names as the metric that matters — a small
 * transcription model hearing "Sarah Chen" as "Sara Chen" — which an exact
 * match misses entirely and an embedding finds only by accident, since
 * embeddings encode meaning rather than spelling.
 */

/**
 * Normalised Levenshtein similarity: 1 for identical, 0 for nothing in common.
 *
 * Case- and whitespace-insensitive, because "sarah chen" and "Sarah  Chen" are
 * the same name written by two transcribers rather than two names.
 */
export function nameSimilarity(left: string, right: string): number {
  const first = normaliseName(left);
  const second = normaliseName(right);
  if (first === second) return 1;
  if (first.length === 0 || second.length === 0) return 0;

  const distance = editDistance(first, second);
  return 1 - distance / Math.max(first.length, second.length);
}

/** Lowercased, with runs of whitespace collapsed and the ends trimmed. */
export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Levenshtein distance, computed over two rows rather than a full matrix.
 *
 * Two rows because the full matrix is not needed — only the distance is, never
 * the alignment — and names are short enough that the constant factor matters
 * more than the asymptotics.
 */
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current.push(cheapestEdit(left, right, { leftIndex, rightIndex, previous, current }));
    }
    previous = current;
  }

  return previous[right.length]!;
}

/** The three edits at one cell, and their costs so far. */
interface EditContext {
  readonly leftIndex: number;
  readonly rightIndex: number;
  readonly previous: readonly number[];
  readonly current: readonly number[];
}

/** The cheapest of substitution, deletion, and insertion at one cell. */
function cheapestEdit(left: string, right: string, context: EditContext): number {
  const { leftIndex, rightIndex, previous, current } = context;
  const isMatch = left[leftIndex - 1] === right[rightIndex - 1];
  const substitution = previous[rightIndex - 1]! + (isMatch ? 0 : 1);
  const deletion = previous[rightIndex]! + 1;
  const insertion = current[rightIndex - 1]! + 1;
  return Math.min(substitution, deletion, insertion);
}
