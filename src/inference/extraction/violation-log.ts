import type { SchemaViolation, SchemaViolationReason } from "../../ports/extractor.js";

/**
 * The drops the parser made, collected rather than discarded.
 *
 * `schema.md` §1 is explicit that a derived field the extractor emits is
 * dropped and **the drop is logged as a schema violation, not accepted
 * quietly**. Collecting into an object passed down the parse rather than
 * writing to a logger is what makes the second half testable: `qa.md` §7.2 asks
 * for both halves tested, and a test that asserts something reached a logger is
 * a test of the logger.
 *
 * It is also the numerator of a metric. Schema violation rate is zero-tolerance
 * in the eval set (`qa.md` §6.1), and a violation that only ever became a log
 * line is one the measurement cannot count.
 */
export class ViolationLog {
  readonly #violations: SchemaViolation[] = [];

  record(reason: SchemaViolationReason, field: string, entityType: string): void {
    this.#violations.push({ reason, field, entityType });
  }

  /** Everything recorded, in the order it was dropped. */
  recorded(): readonly SchemaViolation[] {
    return [...this.#violations];
  }
}
