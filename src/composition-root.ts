import { CAPTURE_TRANSLATORS } from "./application/pipeline/capture-translators.js";
import { Executor } from "./application/pipeline/execute-command.js";
import { SqliteEventStore } from "./infrastructure/persistence/sqlite-event-store.js";
import type { EventStore } from "./ports/event-store.js";

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
  return new SqliteEventStore(options.databaseFile ?? ":memory:");
}

/** The executor, wired to a store. The clock is injected so tests can pin it. */
export function createExecutor(store: EventStore, now: () => string = defaultClock): Executor {
  return new Executor(store, CAPTURE_TRANSLATORS, now);
}

function defaultClock(): string {
  return new Date().toISOString();
}
