import type Database from "better-sqlite3";
import { CAPTURE_TRANSLATORS } from "./application/pipeline/capture-translators.js";
import { Executor } from "./application/pipeline/execute-command.js";
import { CaptureExtraction } from "./application/pipeline/extract-capture.js";
import { CaptureIngestion } from "./application/pipeline/ingest-capture.js";
import { CaptureRecovery } from "./application/pipeline/recover-captures.js";
import { openDatabase } from "./infrastructure/persistence/database.js";
import {
  AnthropicExtractor,
  ANTHROPIC_PROVIDER,
} from "./infrastructure/llm/anthropic-extractor.js";
import { LOCAL_PROVIDER, LocalExtractor } from "./infrastructure/llm/local-extractor.js";
import { OPENAI_PROVIDER, OpenAiExtractor } from "./infrastructure/llm/openai-extractor.js";
import { SqliteCaptureStore } from "./infrastructure/persistence/sqlite-capture-store.js";
import { SqliteEventStore } from "./infrastructure/persistence/sqlite-event-store.js";
import { SqliteProposalStore } from "./infrastructure/persistence/sqlite-proposal-store.js";
import { WhisperCliTranscriber } from "./infrastructure/transcription/whisper-cli-transcriber.js";
import type { CaptureStore } from "./ports/capture-store.js";
import type { EventStore } from "./ports/event-store.js";
import type { Extractor } from "./ports/extractor.js";
import type { ProposalStore } from "./ports/proposal-store.js";
import type { Transcriber } from "./ports/transcriber.js";

/**
 * The one module permitted to import `infrastructure/` (ADR-0001, ADR-0003).
 * Everything else depends on `ports/`, and the lint rule in
 * `tests/boundaries/` fails the build if that stops being true.
 */

/** Where the log lives. `:memory:` keeps a suite off the disk entirely. */
export interface StorageOptions {
  readonly databaseFile?: string;
}

/**
 * The event store. There is one adapter: SQLite, which runs against `:memory:`
 * for tests and a file in production.
 *
 * A second in-memory adapter was built here and removed. `add.md` §9 asks for
 * in-memory adapters alongside the real ones so tests need no network and no
 * database, but `EventStore` is the port where that reasoning does not apply —
 * SQLite already has an in-memory mode, so the fake duplicated an
 * implementation that already had one. The two silently disagreed about
 * whether a stored event could be edited in place, which is a Tier 0 property
 * (`qa.md` §4.4). The rule still holds for the ports that reach a model, where
 * there is nothing to stand in for a real extractor.
 */
export function createEventStore(options: StorageOptions = {}): EventStore {
  return new SqliteEventStore(openDatabase(options.databaseFile));
}

/**
 * Both truth tables, on one connection.
 *
 * They are separate ports because Captures are input and events are change
 * (`add.md` §9), and one connection because the startup sweep anti-joins across
 * both tables — and because WAL assumes a single writer (`runtime.md` §1).
 */
export interface Storage {
  readonly events: EventStore;
  readonly captures: CaptureStore;
  /**
   * Extraction's output, recorded against its Capture so the next stage can
   * resume from it. On the same connection as the other two: the pipeline is
   * serialised to one Capture at a time (`add.md` §4), so one writer is a
   * property of the design rather than a constraint WAL imposes on it.
   */
  readonly proposals: ProposalStore;
  /** Closes the shared connection. No store owns it, so none of them closes it. */
  readonly close: () => void;
}

export function createStorage(options: StorageOptions = {}): Storage {
  const database: Database.Database = openDatabase(options.databaseFile);
  return {
    events: new SqliteEventStore(database),
    captures: new SqliteCaptureStore(database),
    proposals: new SqliteProposalStore(database),
    close: () => database.close(),
  };
}

/**
 * Where the transcriber's binary and model are.
 *
 * Configurable because `runtime.md` §2 offers `large-v3` as an optional
 * download, and swapping models has to stay a path change rather than a code
 * change — which is the property shelling out to the CLI was chosen for.
 */
export interface TranscriptionOptions {
  readonly whisperBinary?: string;
  readonly whisperModel?: string;
}

const DEFAULT_WHISPER_BINARY = "whisper-cli";
const DEFAULT_WHISPER_MODEL = "models/ggml-small.en.bin";

export function createTranscriber(options: TranscriptionOptions = {}): Transcriber {
  return new WhisperCliTranscriber({
    binaryPath: options.whisperBinary ?? process.env.OTTO_WHISPER_BIN ?? DEFAULT_WHISPER_BINARY,
    modelPath: options.whisperModel ?? process.env.OTTO_WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL,
  });
}

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

/** The extraction stage, wired to storage and an extractor. */
export function createExtraction(
  storage: Storage,
  extractor: Extractor,
  now: () => string = defaultClock,
): CaptureExtraction {
  return new CaptureExtraction(extractor, storage.proposals, now);
}

/** Ingestion, wired to storage. The clock is injected so tests can pin it. */
export function createIngestion(
  storage: Storage,
  now: () => string = defaultClock,
): CaptureIngestion {
  const { captures, events } = storage;
  return new CaptureIngestion({ captures, events }, createExecutor(events, now), now);
}

/** The startup sweep, which re-emits events for rows that crashed without one. */
export function createRecovery(storage: Storage, ingestion: CaptureIngestion): CaptureRecovery {
  return new CaptureRecovery(storage.captures, ingestion);
}

/** The executor, wired to a store. The clock is injected so tests can pin it. */
export function createExecutor(store: EventStore, now: () => string = defaultClock): Executor {
  return new Executor(store, CAPTURE_TRANSLATORS, now);
}

function defaultClock(): string {
  return new Date().toISOString();
}
