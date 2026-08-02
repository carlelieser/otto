import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  createAdjudication,
  createBootstrapStatus,
  createExtraction,
  createExtractor,
  createIngestion,
  createRecovery,
  createReviewQueue,
  createStorage,
  createTranscriber,
} from "../../composition-root.js";
import { dispatch, type Methods } from "./dispatch.js";
import { sidecarMethods } from "./methods.js";

/**
 * The sidecar's entrypoint: newline-delimited JSON-RPC on stdin and stdout.
 *
 * Line-delimited rather than Content-Length framed. The framing exists to carry
 * payloads with newlines in them, and every message here is one JSON object on
 * one line — `JSON.stringify` never emits a raw newline, so the simpler framing
 * is not a shortcut that has to be undone later.
 *
 * Nothing is written to stdout that is not a response. Diagnostics go to
 * stderr, because a stray `console.log` in a handler would otherwise arrive at
 * the host as a malformed message.
 */
export async function runSidecar(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  methods: Methods = sidecarMethods(),
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const response = await dispatch(line, methods);
    if (response !== null) output.write(`${JSON.stringify(response)}\n`);
  }
}

/**
 * Everything the sidecar needs to capture, wired to the real adapters, with the
 * startup sweep run before the first request is served.
 *
 * The sweep goes here rather than inside a handler because it is a recovery
 * step for the *previous* run: a Capture whose event never landed is invisible
 * to the pipeline until it is re-emitted, and the moment both processes agree
 * nothing is mid-write is startup.
 */
async function startCaptureSidecar(): Promise<void> {
  const databaseFile = process.env.OTTO_DATABASE;
  const storage = createStorage(databaseFile === undefined ? {} : { databaseFile });
  const ingestion = createIngestion(storage);
  await createRecovery(storage, ingestion).recoverUningestedCaptures();
  // `createExtractor` reads the environment and falls back to the local path,
  // so an unconfigured sidecar starts and serves rather than refusing to boot
  // (ADR-0016). Nothing here checks for a key.
  await runSidecar(
    process.stdin,
    process.stdout,
    sidecarMethods({
      ingestion,
      transcriber: createTranscriber(),
      extraction: createExtraction(storage, createExtractor()),
      captures: storage.captures,
      review: createReviewQueue(storage),
      adjudication: createAdjudication(storage),
      bootstrap: createBootstrapStatus(storage),
    }),
  );
}

/**
 * Only run the loop when executed as a program, so tests can import the module.
 *
 * Compared by resolved path rather than by filename: a suffix match would also
 * fire for any other file whose name ends the same way, and a sidecar that
 * starts reading stdin inside a test run is a hang with no obvious cause.
 */
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await startCaptureSidecar();
}
