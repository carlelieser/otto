import {
  AnthropicExtractor,
  ANTHROPIC_PROVIDER,
} from "../infrastructure/llm/anthropic-extractor.js";
import { LOCAL_PROVIDER, LocalExtractor } from "../infrastructure/llm/local-extractor.js";
import { OPENAI_PROVIDER, OpenAiExtractor } from "../infrastructure/llm/openai-extractor.js";
import type { Extractor } from "../ports/extractor.js";

/**
 * **Which extractor adapter Otto runs**, split out of the composition root
 * because it is the one wiring question with real branching in it.
 *
 * Everything else the root does is "construct this adapter with that
 * connection". This answers a question — local or cloud, and which cloud —
 * from configuration that may be absent, contradictory, or misspelled, and
 * ADR-0016's rule that the unconfigured state is the primary configuration
 * means every one of those paths has to land somewhere sensible. That is a
 * different kind of code from the rest of the root, and it was the part making
 * the root outgrow a readable length.
 *
 * It stays inside the composition boundary: this module imports
 * `infrastructure/` and the layering rule in `tests/boundaries/` permits it
 * here and in the root alone (ADR-0001, ADR-0003).
 */

/**
 * How extraction is configured. Every field is optional, and that is the
 * decision rather than an ergonomic detail: Otto is fully functional before any
 * provider is configured (ADR-0016).
 */
export interface ExtractionOptions {
  /**
   * Which provider satisfies the `Extractor` port. Per port rather than global,
   * because a user may want cloud extraction and local adjudication.
   *
   * Read from the environment when absent, and `local` when that is absent too.
   */
  readonly provider?: string;
  readonly model?: string;
  /** The local runtime's OpenAI-compatible base URL. */
  readonly baseUrl?: string;
  /** The cloud provider's key. Absent is the ordinary case, not an error. */
  readonly apiKey?: string;
}

/**
 * The extractor, defaulting to the local path.
 *
 * **The unconfigured state is the primary configuration, not an edge case**
 * (`qa.md` §6.3, ADR-0016). Nothing here throws when no provider is named and
 * no key is present: that path returns the local adapter, which is what Otto
 * runs out of the box.
 *
 * Removing a previously-configured provider therefore leaves Otto functional
 * rather than stalled — the environment stops naming a provider and this falls
 * back, which is a different outcome from "captures accumulate" because nothing
 * is unavailable.
 */
export function createExtractor(options: ExtractionOptions = {}): Extractor {
  const provider = options.provider ?? process.env.OTTO_EXTRACTION_PROVIDER ?? LOCAL_PROVIDER;
  const apiKey = options.apiKey ?? cloudKeyFor(provider);
  if (provider === LOCAL_PROVIDER || apiKey === undefined) return createLocalExtractor(options);
  return createCloudExtractor(provider, apiKey, options);
}

function createLocalExtractor(options: ExtractionOptions): Extractor {
  const baseUrl = options.baseUrl ?? process.env.OTTO_LOCAL_BASE_URL;
  const model = options.model ?? process.env.OTTO_LOCAL_MODEL;
  return new LocalExtractor({
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
  });
}

/**
 * A named cloud provider, or the local path when the name is not one Otto has
 * an adapter for.
 *
 * An unrecognised provider name falls back rather than throwing, for the reason
 * ADR-0016 gives: a typo in a configuration file should degrade to the default
 * Otto is built to run on, not stop the pipeline. The provider is recorded on
 * every Proposal, so which adapter actually ran stays answerable afterwards.
 */
function createCloudExtractor(
  provider: string,
  apiKey: string,
  options: ExtractionOptions,
): Extractor {
  const model = options.model;
  const settings = { apiKey, ...(model === undefined ? {} : { model }) };
  if (provider === ANTHROPIC_PROVIDER) return new AnthropicExtractor(settings);
  if (provider === OPENAI_PROVIDER) return new OpenAiExtractor(settings);
  return createLocalExtractor(options);
}

/** The key a cloud provider reads, or `undefined` when it is not configured. */
function cloudKeyFor(provider: string): string | undefined {
  if (provider === ANTHROPIC_PROVIDER) return process.env.ANTHROPIC_API_KEY;
  if (provider === OPENAI_PROVIDER) return process.env.OPENAI_API_KEY;
  return undefined;
}
