import { parseExtraction } from "../../inference/extraction/parse-extraction.js";
import type { Extraction, ExtractionRequest, Extractor } from "../../ports/extractor.js";

/**
 * An `Extractor` returning canned output, so the pipeline runs with no model at
 * all.
 *
 * This is the case where a second adapter *is* load-bearing (`add.md` §9).
 * There is no offline mode for an LLM — unlike `EventStore`, where SQLite's
 * `:memory:` is the real adapter with no disk — so without a stub returning
 * canned output nothing downstream of extraction is testable, and the eval set
 * cannot run in CI on every commit.
 *
 * It answers from a fixed corpus keyed by note text and returns an empty
 * extraction for anything it does not recognise. Empty rather than a throw
 * because "no extractable entity" is a valid outcome (`qa.md` §6.2), and an
 * unrecognised note in a test is far more often an incomplete fixture than a
 * failure worth stopping on.
 *
 * **It parses its canned output through the same parser the real adapters use.**
 * Slice 0 built an in-memory `EventStore` whose stored events could be edited in
 * place, which the SQLite adapter refused, and no test noticed because each
 * adapter was only ever compared against itself (`add.md` §9). Routing through
 * `parseExtraction` is what keeps that from happening here: a fixture claiming a
 * field the schema does not have fails in the stub exactly as it would against a
 * model.
 */
export class InMemoryExtractor implements Extractor {
  readonly #responses: ReadonlyMap<string, unknown>;
  readonly #provider: string;
  readonly #modelVersion: string;

  constructor(options: InMemoryExtractorOptions = {}) {
    this.#responses = new Map(options.responses ?? []);
    this.#provider = options.provider ?? IN_MEMORY_PROVIDER;
    this.#modelVersion = options.modelVersion ?? IN_MEMORY_MODEL;
  }

  async extract(request: ExtractionRequest): Promise<Extraction> {
    const canned = this.#responses.get(request.text.trim());
    const { mentions, violations } = parseExtraction(canned ?? EMPTY_OUTPUT);
    return { mentions, violations, provider: this.#provider, modelVersion: this.#modelVersion };
  }
}

/**
 * What an unrecognised note produces: a valid extraction claiming nothing.
 *
 * Not a throw, and not a mention with an empty name. A note containing no
 * extractable entity is a real case the corpus carries deliberately, and it
 * must not produce a spurious Proposal.
 */
const EMPTY_OUTPUT = { mentions: [] };

export interface InMemoryExtractorOptions {
  /** Raw model-shaped output keyed by the exact note text it answers. */
  readonly responses?: Iterable<readonly [string, unknown]>;
  /**
   * What to record as the provider. Overridable because the measurement runs
   * the same corpus through several adapters and reports per provider
   * (`qa.md` §6.1) — a stub standing in for one of them has to say which.
   */
  readonly provider?: string;
  readonly modelVersion?: string;
}

/**
 * The provider name the stub records.
 *
 * Deliberately not `local`. Provenance carries the provider on every Proposal
 * so a knowledge base built across a configuration change stays legible
 * (ADR-0016), and a stub that claimed to be the local model would put
 * unattributable rows in the correction log that triage's per-model thresholds
 * later key on (ADR-0008).
 */
export const IN_MEMORY_PROVIDER = "in-memory";

export const IN_MEMORY_MODEL = "canned";
