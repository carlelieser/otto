import type Database from "better-sqlite3";
import { CAPTURE_TRANSLATORS } from "./application/pipeline/capture-translators.js";
import { Executor } from "./application/pipeline/execute-command.js";
import { CaptureIngestion } from "./application/pipeline/ingest-capture.js";
import { CaptureRecovery } from "./application/pipeline/recover-captures.js";
import { openDatabase } from "./infrastructure/persistence/database.js";
import { SqliteCaptureStore } from "./infrastructure/persistence/sqlite-capture-store.js";
import { SqliteEventStore } from "./infrastructure/persistence/sqlite-event-store.js";
import { WhisperCliTranscriber } from "./infrastructure/transcription/whisper-cli-transcriber.js";
import type { CaptureStore } from "./ports/capture-store.js";
import type { EventStore } from "./ports/event-store.js";
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
  /** Closes the shared connection. Neither store owns it, so neither closes it. */
  readonly close: () => void;
}

export function createStorage(options: StorageOptions = {}): Storage {
  const database: Database.Database = openDatabase(options.databaseFile);
  return {
    events: new SqliteEventStore(database),
    captures: new SqliteCaptureStore(database),
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
