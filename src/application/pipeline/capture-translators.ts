import { INGEST_CAPTURE } from "../../domain/commands/command.js";
import {
  CAPTURE_INGESTED,
  CAPTURE_INGESTED_VERSION,
} from "../../domain/events/capture-ingested.js";
import type { CommandTranslator } from "./execute-command.js";

/**
 * The Commands the executor understands, and the events each produces.
 *
 * One entry for now: `CaptureIngested` proves the write path end to end, and
 * Slice 1 needs it anyway. Later slices add rows rather than reshaping this.
 */
export const CAPTURE_TRANSLATORS: ReadonlyMap<string, CommandTranslator> = new Map<
  string,
  CommandTranslator
>([
  [
    INGEST_CAPTURE,
    (command) => ({
      type: CAPTURE_INGESTED,
      version: CAPTURE_INGESTED_VERSION,
      payload: command.payload,
    }),
  ],
]);
