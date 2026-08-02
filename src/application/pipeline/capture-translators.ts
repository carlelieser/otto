import { CORRECT_TRANSCRIPT, INGEST_CAPTURE } from "../../domain/commands/command.js";
import {
  CAPTURE_TRANSCRIPT_CORRECTED,
  CAPTURE_TRANSCRIPT_CORRECTED_VERSION,
} from "../../domain/events/capture-corrected.js";
import {
  CAPTURE_INGESTED,
  CAPTURE_INGESTED_VERSION,
} from "../../domain/events/capture-ingested.js";
import type { CommandTranslator } from "./execute-command.js";

/**
 * The Commands the executor understands, and the events each produces.
 *
 * Two entries: ingestion, and Slice 9's correction. Later slices add rows
 * rather than reshaping this.
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
  [
    CORRECT_TRANSCRIPT,
    (command) => ({
      type: CAPTURE_TRANSCRIPT_CORRECTED,
      version: CAPTURE_TRANSCRIPT_CORRECTED_VERSION,
      payload: command.payload,
    }),
  ],
]);
