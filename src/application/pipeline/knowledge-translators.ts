import {
  ADD_TO_SET,
  CLEAR_FIELD,
  CREATE_ENTITY,
  RELATE,
  SET_FIELD,
} from "../../domain/commands/knowledge-commands.js";
import {
  ENTITIES_RELATED,
  ENTITY_CREATED,
  FIELD_CLEARED,
  FIELD_SET,
  KNOWLEDGE_EVENT_VERSION,
  SET_MEMBER_ADDED,
} from "../../domain/events/knowledge-events.js";
import type { CommandTranslator } from "./execute-command.js";

/**
 * Each knowledge Command and the event it produces, completing the write path
 * from triage to the log (`add.md` §5.6).
 *
 * The translation is deliberately mechanical — the payload passes through
 * untouched and only the tense changes. Everything that *could* be refused was
 * refused earlier: the differ would not have built a Command naming a field
 * that does not exist, and triage would not have sent one the application
 * policy forbids. What is left for a translator to decide is nothing, and that
 * is the property that makes the executor the boring end of a careful pipeline
 * rather than a second place decisions get made.
 *
 * The version check the executor runs before any of these is the one thing that
 * can still refuse a Command here, and it refuses for a reason none of these
 * translators could know about: the aggregate moved while a human was thinking
 * (`triage.md` §8).
 */
export const KNOWLEDGE_TRANSLATORS: ReadonlyMap<string, CommandTranslator> = new Map(
  [
    [CREATE_ENTITY, ENTITY_CREATED],
    [SET_FIELD, FIELD_SET],
    [ADD_TO_SET, SET_MEMBER_ADDED],
    [CLEAR_FIELD, FIELD_CLEARED],
    [RELATE, ENTITIES_RELATED],
  ].map(([commandType, eventType]) => [
    commandType!,
    (command) => ({
      type: eventType!,
      version: KNOWLEDGE_EVENT_VERSION,
      payload: command.payload,
    }),
  ]),
);
