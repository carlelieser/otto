import { renderSections } from "../../inference/salience/brief-selection.js";
import type { BriefGenerator, BriefRequest, GeneratedBrief } from "../../ports/brief-generator.js";

/**
 * A `BriefGenerator` that writes from the selection alone, so briefs compose
 * with no model at all.
 *
 * **It cannot invent an entity**, because it only ever writes down names it was
 * handed. That makes it the honest default for tests whose subject is selection
 * or storage rather than prose — a stub that produced plausible sentences would
 * put unselected names in briefs and turn every such test into a test of the
 * no-new-entities check.
 *
 * Its output is deliberately not good prose. Prose quality is a product
 * question `qa.md` §10 keeps at smoke level, and a stub that read well would
 * invite assertions about wording that the real adapter would then have to
 * satisfy.
 */
export class InMemoryBriefGenerator implements BriefGenerator {
  readonly #provider: string;
  readonly #modelVersion: string;
  readonly #canned: string | undefined;

  constructor(options: InMemoryBriefGeneratorOptions = {}) {
    this.#provider = options.provider ?? IN_MEMORY_BRIEF_PROVIDER;
    this.#modelVersion = options.modelVersion ?? IN_MEMORY_BRIEF_MODEL;
    this.#canned = options.prose;
  }

  async generate(request: BriefRequest): Promise<GeneratedBrief> {
    return {
      prose: this.#canned ?? renderSections(request.sections),
      provider: this.#provider,
      modelVersion: this.#modelVersion,
    };
  }
}

export interface InMemoryBriefGeneratorOptions {
  /**
   * Prose to return instead of the selection, for tests about the
   * no-new-entities check.
   *
   * The one way to make this stub emit a name nobody selected, and it takes a
   * deliberate act to do it — which is the right cost for the thing the
   * constraint exists to catch.
   */
  readonly prose?: string;
  readonly provider?: string;
  readonly modelVersion?: string;
}

/** Deliberately not `local`, matching the other in-memory adapters (ADR-0016). */
export const IN_MEMORY_BRIEF_PROVIDER = "in-memory";

export const IN_MEMORY_BRIEF_MODEL = "canned";
