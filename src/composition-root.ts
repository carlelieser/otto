import type Database from "better-sqlite3";
import { CAPTURE_TRANSLATORS } from "./application/pipeline/capture-translators.js";
import { KNOWLEDGE_TRANSLATORS } from "./application/pipeline/knowledge-translators.js";
import { type CommandTranslator, Executor } from "./application/pipeline/execute-command.js";
import { TranscriptCorrection } from "./application/pipeline/correct-transcript.js";
import { CaptureExtraction } from "./application/pipeline/extract-capture.js";
import { CaptureIngestion } from "./application/pipeline/ingest-capture.js";
import { CaptureReextraction } from "./application/pipeline/reextract-capture.js";
import { CaptureRecovery } from "./application/pipeline/recover-captures.js";
import { ProposalAdjudication } from "./application/pipeline/adjudicate-proposal.js";
import { DuplicateDetection } from "./application/pipeline/detect-duplicates.js";
import { CaptureTriage, type CorrectionCounts } from "./application/pipeline/triage-capture.js";
export { createBriefProduction, createScheduler } from "./composition/schedule-wiring.js";
import { ReviewQueue } from "./application/surface/read-review-queue.js";
import { BootstrapStatus } from "./application/surface/read-bootstrap-status.js";
import { openDatabase } from "./infrastructure/persistence/database.js";
import { SqliteEntityViewStore } from "./infrastructure/persistence/sqlite-entity-view-store.js";
import { SqliteProjectionStore } from "./infrastructure/persistence/sqlite-projection-store.js";
import { createExtractor, type ExtractionOptions } from "./composition/extractor-selection.js";
import { SqliteCaptureStore } from "./infrastructure/persistence/sqlite-capture-store.js";
import { SqliteEventStore } from "./infrastructure/persistence/sqlite-event-store.js";
import { SqliteEntityRepository } from "./infrastructure/persistence/sqlite-entity-repository.js";
import { SqliteProposalStore } from "./infrastructure/persistence/sqlite-proposal-store.js";
import { SqliteDispositionStore } from "./infrastructure/persistence/sqlite-disposition-store.js";
import { SqliteReviewQueueStore } from "./infrastructure/persistence/sqlite-review-queue-store.js";
import { SqliteCorrectionStore } from "./infrastructure/persistence/sqlite-correction-store.js";
import { SqliteBriefStore } from "./infrastructure/persistence/sqlite-brief-store.js";
import { LocalEmbedder } from "./infrastructure/embedding/local-embedder.js";
import { LocalAdjudicator } from "./infrastructure/llm/local-adjudicator.js";
import { WhisperCliTranscriber } from "./infrastructure/transcription/whisper-cli-transcriber.js";
import type { CandidateReads } from "./inference/resolution/candidate-generation.js";
import type { Adjudicator } from "./ports/adjudicator.js";
import type { CaptureStore } from "./ports/capture-store.js";
import type { DispositionStore } from "./ports/disposition-store.js";
import type { Embedder } from "./ports/embedder.js";
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
  /**
   * Triage's decision about each Proposal, and the only place a discard is
   * visible from (`triage.md` §7).
   *
   * On the same connection as the rest for the same reason: the pipeline is
   * serialised to one Capture at a time, so one writer is a property of the
   * design rather than a constraint WAL imposes on it.
   */
  readonly dispositions: DispositionStore;
  /**
   * The entity projection resolution reads current knowledge through.
   *
   * On the same connection as the rest, and derived rather than truth — every
   * `projection_` table is droppable and rebuildable from the log alone
   * (`add.md` §6). The concrete type is exposed rather than the port because
   * the projection worker writes through it; `inference/` is handed the reads
   * only, which is what keeps ADR-0003 structural.
   */
  readonly entities: SqliteEntityRepository;
  /**
   * Where the projection worker writes, and how far it has folded.
   *
   * On the same connection as everything else, which is what makes the
   * worker's write atomic with its position: a projection whose recorded
   * position ran ahead of its rows would resume past events it never folded.
   *
   * The worker runs in its own process (`add.md` §4) so a rebuild never blocks
   * capture. That is a deployment fact rather than a wiring one — the process
   * opens its own `Storage` against the same file, and SQLite's WAL is what
   * lets it read while the pipeline writes (`runtime.md` §1).
   */
  readonly projections: SqliteProjectionStore;
  /**
   * The triaged Proposals the review queue shows (Slice 7).
   *
   * A `projection_` table on the same connection as the rest: rebuildable by
   * re-running the differ and triage over stored Captures, which is ADR-0019's
   * argument one stage later.
   */
  readonly queue: SqliteReviewQueueStore;
  /**
   * What the user chose instead, and the bootstrap counter behind it
   * (ADR-0006, `triage.md` §4).
   *
   * The calibration corpus. Nothing in MVP consumes it beyond the counter —
   * the eval set and the threshold tuner are post-MVP (PRD §7.2) — and it is
   * gathered now because it is unreconstructable later.
   */
  readonly corrections: SqliteCorrectionStore;
  /**
   * Stored briefs and the instrumentation that replaces salience v0
   * (`salience.md` §4, §5).
   *
   * Not a `projection_` table and not emptied by a rebuild: a brief is a record
   * of what mattered on a day under the coefficients in force that day, and
   * recomputing it under v1's would produce a different one (ADR-0015).
   */
  readonly briefs: SqliteBriefStore;
  /** The read path: entity views, provenance, and full-text search. */
  readonly views: SqliteEntityViewStore;
  /** Closes the shared connection. No store owns it, so none of them closes it. */
  readonly close: () => void;
}

export function createStorage(options: StorageOptions = {}): Storage {
  const database: Database.Database = openDatabase(options.databaseFile);
  return { ...truthStores(database), ...projectionStores(database), close: () => database.close() };
}

/**
 * The two tables that are truth, the derived tables the pipeline writes, and
 * briefs.
 *
 * Briefs sit here rather than with the projections because they survive a
 * rebuild: a brief records what mattered on a day under the rules in force that
 * day, and recomputing it under v1's coefficients would produce a different
 * brief (ADR-0015, `schema.ts`). Grouping it with the rebuildable stores would
 * put it one refactor away from being emptied by `reset`.
 */
function truthStores(database: Database.Database) {
  return {
    events: new SqliteEventStore(database),
    captures: new SqliteCaptureStore(database),
    proposals: new SqliteProposalStore(database),
    dispositions: new SqliteDispositionStore(database),
    briefs: new SqliteBriefStore(database),
  };
}

/** Everything rebuildable from the log: the `projection_` tables and their reads. */
function projectionStores(database: Database.Database) {
  return {
    entities: new SqliteEntityRepository(database),
    projections: new SqliteProjectionStore(database),
    views: new SqliteEntityViewStore(database),
    queue: new SqliteReviewQueueStore(database),
    corrections: new SqliteCorrectionStore(database),
  };
}

/**
 * Re-exported so callers keep one import path for wiring.
 *
 * The projection worker, its upcasts, and the read surfaces are assembled in
 * `composition/projection-wiring.ts`; that they moved is not something a caller
 * of the root should have to notice.
 */
export {
  createKnowledgeReads,
  createProjectionWorker,
  createUpcastRegistry,
} from "./composition/projection-wiring.js";

/**
 * The embedder, which is local always and has no cloud option
 * (`runtime.md` §2, `stack.md` §5).
 *
 * The one inference port with no opt-in cloud adapter. Embeddings serve
 * candidate generation rather than user-facing search, the quality bar is
 * "narrow thousands of entities to a handful," and sending every entity the
 * user knows to a provider for that job is a privacy cost with no return.
 */
export function createEmbedder(options: EmbeddingOptions = {}): Embedder {
  const baseUrl = options.baseUrl ?? process.env.OTTO_LOCAL_BASE_URL;
  const model = options.model ?? process.env.OTTO_EMBEDDING_MODEL;
  return new LocalEmbedder({
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
  });
}

export interface EmbeddingOptions {
  readonly baseUrl?: string;
  readonly model?: string;
}

/**
 * The adjudicator, configured **per port** rather than globally
 * (`add.md` §9).
 *
 * A user may want cloud extraction and local adjudication: the two are
 * different jobs with different costs, since extraction reads a whole note
 * under a grammar and adjudication picks one of four. Defaults to local for
 * ADR-0016's reason — the unconfigured state is the primary configuration.
 */
export function createAdjudicator(options: AdjudicationOptions = {}): Adjudicator {
  const baseUrl = options.baseUrl ?? process.env.OTTO_LOCAL_BASE_URL;
  const model = options.model ?? process.env.OTTO_ADJUDICATION_MODEL;
  return new LocalAdjudicator({
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
  });
}

export interface AdjudicationOptions {
  readonly baseUrl?: string;
  readonly model?: string;
}

/**
 * The reads resolution is given, narrowed to exactly what it may do.
 *
 * `inference/` never names a repository port (`add.md` §3), so this is the
 * function that hands it the three reads and nothing else. The narrowing is
 * the point: what resolution cannot write is not a rule someone has to
 * remember, it is an object with no write method on it.
 */
export function createCandidateReads(storage: Storage): CandidateReads {
  const { entities } = storage;
  return {
    byExactName: (name, type) => entities.byExactName(name, type),
    byFuzzyName: (name, type) => entities.byFuzzyName(name, type),
    byNearestEmbedding: (query) => entities.byNearestEmbedding(query),
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
 * Re-exported so callers keep one import path for wiring.
 *
 * The selection logic lives in `composition/extractor-selection.ts`; that it
 * moved is not something a caller of the root should have to notice.
 */
export { createExtractor, type ExtractionOptions };

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

/**
 * Transcript correction, wired to the Capture store and the executor.
 *
 * No extractor is passed, and none could be: the re-run is the caller's, which
 * is what keeps "this stage mutates nothing" checkable by reading its imports
 * (`correct-transcript.ts`).
 */
export function createCorrection(
  storage: Storage,
  now: () => string = defaultClock,
): TranscriptCorrection {
  return new TranscriptCorrection({
    captures: storage.captures,
    executor: createExecutor(storage.events, now),
    currentVersionOf: (aggregateId) => storage.events.currentVersion(aggregateId),
    reindexCaptures: () => storage.projections.reindexCaptures(),
    now,
  });
}

/**
 * The re-run a correction triggers (`runtime.md` §3, §5).
 *
 * Takes the extraction stage rather than an extractor, so the model a re-run
 * uses is the one the pipeline is configured with — a second extractor here
 * would be a second answer to "which model is Otto running" (ADR-0016).
 */
export function createReextraction(
  extraction: CaptureExtraction,
  storage: Storage,
): CaptureReextraction {
  return new CaptureReextraction(extraction, storage.proposals);
}

/** The startup sweep, which re-emits events for rows that crashed without one. */
export function createRecovery(storage: Storage, ingestion: CaptureIngestion): CaptureRecovery {
  return new CaptureRecovery(storage.captures, ingestion);
}

/** The review queue as a read surface: requests, records, and the discard section. */
export function createReviewQueue(storage: Storage): ReviewQueue {
  return new ReviewQueue(storage.queue, storage.dispositions, storage.projections);
}

/**
 * Duplicate detection, reading the entity projection and writing the queue.
 *
 * It is handed the one read it makes rather than the view store, for the reason
 * `createCandidateReads` narrows resolution's: a stage that cannot search is one
 * with nothing to search with. It reaches no executor at all, which is what
 * makes "a merge never applies unattended" structural here rather than a rule
 * this stage remembers — there is nothing on it to apply a Command with.
 */
export function createDuplicateDetection(
  storage: Storage,
  now: () => string = defaultClock,
): DuplicateDetection {
  return new DuplicateDetection({
    entities: (type) => storage.views.entitiesOfType(type),
    queue: storage.queue,
    now,
  });
}

/** Bootstrap status, so the dashboard can say why Otto is asking (`triage.md` §4). */
export function createBootstrapStatus(storage: Storage): BootstrapStatus {
  return new BootstrapStatus(storage.corrections);
}

/**
 * Adjudication, wired to the executor and the two stores it writes.
 *
 * No extractor is passed, and none could be: the correction path issues a
 * Command directly to the executor and does not re-enter the pipeline
 * (`add.md` §7).
 */
export function createAdjudication(
  storage: Storage,
  now: () => string = defaultClock,
): ProposalAdjudication {
  return new ProposalAdjudication({
    executor: createExecutor(storage.events, now),
    queue: storage.queue,
    corrections: storage.corrections,
    currentVersionOf: (aggregateId) => storage.events.currentVersion(aggregateId),
    resolveId: (aggregateId) => storage.views.resolveId(aggregateId),
    now,
  });
}

/**
 * The bootstrap counter, reading the corrections that now exist.
 *
 * This is what `NO_CORRECTIONS` was standing in for. Until this slice the
 * honest answer was zero and Otto was in permanent bootstrap (ADR-0022); with
 * corrections accumulating, the fifty-Correction threshold becomes reachable
 * and the count is per provider and model version (ADR-0008).
 *
 * It reaches the running system through `createTriage` below, which is the
 * assembly a pipeline driver takes. **No such driver exists yet**: triage has
 * been wired and undriven since Slice 5, because nothing between capture and
 * here orchestrates the stages end to end. That orchestration is not this
 * slice's, and saying so beats a comment that implies the counter is live.
 */
export function createCorrectionCounts(storage: Storage): CorrectionCounts {
  return {
    forModel: (provider, modelVersion) => storage.corrections.countForModel(provider, modelVersion),
  };
}

/** Triage, wired to storage, the executor, and the real correction counter. */
export function createTriage(storage: Storage, now: () => string = defaultClock): CaptureTriage {
  return new CaptureTriage({
    executor: createExecutor(storage.events, now),
    dispositions: storage.dispositions,
    queue: storage.queue,
    corrections: createCorrectionCounts(storage),
    now,
  });
}

/**
 * Every Command the executor understands: Captures and knowledge.
 *
 * Two maps merged rather than one growing map, because they arrived with
 * different stages and answer to different documents — ingestion's is `add.md`
 * §5.1, and the knowledge ones are §5.4's closed vocabulary. Merged here, in
 * the composition root, because assembling the whole from its parts is what
 * this module is for.
 */
export const ALL_TRANSLATORS: ReadonlyMap<string, CommandTranslator> = new Map([
  ...CAPTURE_TRANSLATORS,
  ...KNOWLEDGE_TRANSLATORS,
]);

/** The executor, wired to a store. The clock is injected so tests can pin it. */
export function createExecutor(store: EventStore, now: () => string = defaultClock): Executor {
  return new Executor(store, ALL_TRANSLATORS, now);
}

function defaultClock(): string {
  return new Date().toISOString();
}
