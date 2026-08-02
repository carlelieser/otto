import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  cosineDistance,
  fromBlob,
  toBlob,
} from "../../src/infrastructure/persistence/vector-distance.js";

describe("the BLOB encoding", () => {
  it("round-trips a vector unchanged", () => {
    const vector = Float32Array.from([0.5, -0.25, 1, 0]);

    expect(fromBlob(toBlob(vector))).toEqual(vector);
  });

  /**
   * `better-sqlite3` reuses its read buffers, so a decoded vector that viewed
   * the buffer rather than copying it would change under the caller between
   * rows — a bug that shows up as every row scoring like the last one.
   */
  it("copies rather than viewing the buffer it decoded", () => {
    const blob = toBlob(Float32Array.from([1, 2, 3]));
    const decoded = fromBlob(blob);
    blob.fill(0);

    expect([...decoded]).toEqual([1, 2, 3]);
  });

  it("round-trips any vector", () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ noNaN: true }), { minLength: 1, maxLength: 64 }),
        (values) => {
          const vector = Float32Array.from(values);
          expect(fromBlob(toBlob(vector))).toEqual(vector);
        },
      ),
    );
  });
});

describe("cosine distance", () => {
  it("is zero for a vector against itself", () => {
    expect(cosineDistance(Float32Array.from([1, 2, 3]), Float32Array.from([1, 2, 3]))).toBeCloseTo(
      0,
    );
  });

  it("is zero for vectors of one direction and different magnitudes", () => {
    expect(cosineDistance(Float32Array.from([1, 0]), Float32Array.from([7, 0]))).toBeCloseTo(0);
  });

  it("is one for orthogonal vectors", () => {
    expect(cosineDistance(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(1);
  });

  it("is two for opposed vectors", () => {
    expect(cosineDistance(Float32Array.from([1, 0]), Float32Array.from([-1, 0]))).toBeCloseTo(2);
  });

  /**
   * An entity whose embedding failed to compute should rank last, not stop a
   * search that has 3,000 other entities to consider.
   */
  it("reports the maximum for a zero vector rather than a NaN", () => {
    const distance = cosineDistance(Float32Array.from([0, 0]), Float32Array.from([1, 0]));

    expect(Number.isNaN(distance)).toBe(false);
    expect(distance).toBe(2);
  });

  it("names both widths when the dimensions disagree", () => {
    expect(() => cosineDistance(Float32Array.from([1]), Float32Array.from([1, 2]))).toThrow(
      /got 1 and 2/,
    );
  });

  it("is symmetric", () => {
    const anyVector = fc.array(fc.float({ min: -10, max: 10, noNaN: true }), {
      minLength: 4,
      maxLength: 4,
    });
    fc.assert(
      fc.property(anyVector, anyVector, (left, right) => {
        const forward = cosineDistance(Float32Array.from(left), Float32Array.from(right));
        const backward = cosineDistance(Float32Array.from(right), Float32Array.from(left));
        expect(forward).toBeCloseTo(backward);
      }),
    );
  });

  it("never leaves the range a cosine distance can occupy", () => {
    const anyVector = fc.array(fc.float({ min: -10, max: 10, noNaN: true }), {
      minLength: 3,
      maxLength: 3,
    });
    fc.assert(
      fc.property(anyVector, anyVector, (left, right) => {
        const distance = cosineDistance(Float32Array.from(left), Float32Array.from(right));
        expect(distance).toBeGreaterThanOrEqual(0);
        expect(distance).toBeLessThanOrEqual(2);
      }),
    );
  });
});
