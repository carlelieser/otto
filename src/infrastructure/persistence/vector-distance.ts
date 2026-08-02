/**
 * Cosine distance between two vectors, and the `BLOB` encoding the projection
 * stores them in.
 *
 * ## Why exact search, and why this is in `infrastructure/`
 *
 * `runtime.md` §4 measured vector search as the likeliest failure of the whole
 * storage assumption and it was not: top-20 over 3,000 × 384d returned in
 * 0.3 ms against a 100 ms bar, and stayed under it to 75,000 entities. The
 * conclusion recorded there is about SQLite rather than about any one
 * extension — **exact search over this corpus is far below the bar, so the
 * design does not depend on approximate indexing.**
 *
 * That is what makes this file legitimate rather than a stand-in. It is the
 * exact-search implementation the spike's numbers describe, doing the scan in
 * process over `BLOB` columns in ordinary tables, which is the shape
 * SQLite-Vector 1.0 uses (`runtime.md` §4.3). The extension is a loadable
 * binary that is not on the machine at test time and cannot be, since it ships
 * per-platform in the installer; loading it when present is a packaging concern
 * for Slice 11.
 *
 * **The licence question §4.3 left open is now answered, and the answer is not
 * "yes".** `sqliteai/sqlite-vector` is dual-licensed: free for projects under
 * an OSI-approved licence, Elastic License 2.0 otherwise, with commercial terms
 * required for production or managed-service deployment. Otto is a distributed
 * desktop installer, so bundling the binary is a licensing decision rather than
 * a dependency addition — see `docs/adr/0021`. The exact scan here needs no
 * extension at all and clears the bar on its own, which is what makes that
 * decision deferrable rather than blocking.
 */

/** Float32, four bytes a component, native byte order — what the column stores. */
export function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * A stored `BLOB` read back as a vector.
 *
 * Copies rather than viewing the buffer, because `better-sqlite3` reuses its
 * read buffers and a view would change under the caller between rows.
 */
export function fromBlob(blob: Buffer): Float32Array {
  const copy = new Float32Array(blob.byteLength / Float32Array.BYTES_PER_ELEMENT);
  Buffer.from(copy.buffer).set(blob);
  return copy;
}

/**
 * Cosine distance in [0, 2]: 0 is identical direction, 1 orthogonal, 2 opposed.
 *
 * Distance rather than similarity so that "nearest" means "smallest" everywhere
 * downstream, which is the convention `byNearestEmbedding` sorts by and the one
 * a reader has to hold only once.
 *
 * A zero-magnitude vector has no direction, so its distance to anything is
 * undefined. It returns the maximum rather than throwing: an entity whose
 * embedding failed to compute should rank last, not stop a search that has
 * 3,000 other entities to consider.
 */
export function cosineDistance(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) {
    throw new Error(
      `cosine distance needs equal dimensions: got ${left.length} and ${right.length}`,
    );
  }

  const { dot, leftMagnitude, rightMagnitude } = accumulate(left, right);
  if (leftMagnitude === 0 || rightMagnitude === 0) return MAXIMUM_DISTANCE;
  return 1 - dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

/** Opposed vectors, and what an undefined comparison reports. */
const MAXIMUM_DISTANCE = 2;

/** The dot product and both squared magnitudes, in one pass. */
function accumulate(
  left: Float32Array,
  right: Float32Array,
): { dot: number; leftMagnitude: number; rightMagnitude: number } {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftComponent = left[index]!;
    const rightComponent = right[index]!;
    dot += leftComponent * rightComponent;
    leftMagnitude += leftComponent * leftComponent;
    rightMagnitude += rightComponent * rightComponent;
  }
  return { dot, leftMagnitude, rightMagnitude };
}
