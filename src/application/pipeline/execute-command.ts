import type { Command } from "../../domain/commands/command.js";
import type { DomainEvent, StoredEvent } from "../../domain/events/domain-event.js";
import type { EventStore } from "../../ports/event-store.js";
import { deriveEventId } from "./event-identity.js";

/** Produces the event a Command implies, or refuses it. */
export type CommandTranslator = (command: Command) => EventDraft;

/** What a translator returns: the event's type, version, and payload. */
export interface EventDraft {
  readonly type: string;
  readonly version: number;
  readonly payload: unknown;
}

/** Supplies `recordedAt`, injected so tests are not at the mercy of the clock. */
export type Clock = () => string;

export class StaleCommandError extends Error {
  constructor(
    readonly aggregateId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Cannot apply command to aggregate ${aggregateId}: ` +
        `expected version ${expectedVersion}, found ${actualVersion}`,
    );
    this.name = "StaleCommandError";
  }
}

export class UnknownCommandError extends Error {
  constructor(readonly commandType: string) {
    super(`Cannot apply command of unknown type ${commandType}`);
    this.name = "UnknownCommandError";
  }
}

/**
 * The only component in Otto permitted to write (ADR-0003), and it writes only
 * to the log. It takes a Command, validates it against the current aggregate,
 * appends a domain event, and returns.
 *
 * It does not update entity tables — those are projections and follow
 * asynchronously (`add.md` §5.6), which is Slice 5's work.
 */
export class Executor {
  readonly #store: EventStore;
  readonly #translators: ReadonlyMap<string, CommandTranslator>;
  readonly #now: Clock;

  constructor(store: EventStore, translators: ReadonlyMap<string, CommandTranslator>, now: Clock) {
    this.#store = store;
    this.#translators = translators;
    this.#now = now;
  }

  /**
   * Applies a Command, returning the event it produced.
   *
   * Throws `StaleCommandError` when the aggregate moved since the Command was
   * computed. Slice 4 turns that into re-proposal from the differ; here it is
   * simply refused, because the version stamp has to be right from the first
   * event even though the recovery behaviour arrives later.
   */
  async execute(command: Command): Promise<StoredEvent> {
    const translate = this.#translators.get(command.type);
    if (translate === undefined) throw new UnknownCommandError(command.type);

    await this.#rejectIfStale(command);
    const [stored] = await this.#store.append([this.#draftEvent(command, translate(command))]);
    return stored!;
  }

  async #rejectIfStale(command: Command): Promise<void> {
    const { id, expectedVersion } = command.aggregate;
    const actualVersion = await this.#store.currentVersion(id);
    if (actualVersion !== expectedVersion) {
      throw new StaleCommandError(id, expectedVersion, actualVersion);
    }
  }

  #draftEvent(command: Command, draft: EventDraft): DomainEvent {
    return {
      eventId: deriveEventId(command),
      type: draft.type,
      version: draft.version,
      payload: draft.payload,
      aggregate: stampedAggregate(command),
      provenance: command.provenance,
      recordedAt: this.#now(),
    };
  }
}

/** The aggregate an event targets, stamped with the version it was computed against. */
function stampedAggregate(command: Command): DomainEvent["aggregate"] {
  return {
    type: command.aggregate.type,
    id: command.aggregate.id,
    version: command.aggregate.expectedVersion,
  };
}
