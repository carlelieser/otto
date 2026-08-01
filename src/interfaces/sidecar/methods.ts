import { stat, unlink } from "node:fs/promises";
import type { Methods } from "./dispatch.js";

/**
 * Everything the sidecar answers in Slice 1.
 *
 * There is no pipeline yet — the sidecar exists here to prove the transport and
 * the supervisor, not to work. `ping` proves the round trip; `readAudio` proves
 * the path handoff and the ownership rule that makes a two-process temporary
 * file safe at all.
 */
export function sidecarMethods(): Methods {
  return { ping, readAudio, exit: exitNow };
}

/**
 * The round-trip proof. Echoes back what it was sent so the host asserts a
 * response rather than merely that nothing threw.
 */
function ping(params: unknown): { pong: unknown } {
  return { pong: params ?? null };
}

export interface AudioReadResult {
  readonly bytes: number;
  readonly deleted: boolean;
}

/**
 * Reads the temporary WAV the host recorded, reports its size, and deletes it.
 *
 * `runtime.md` §2 puts deletion on the sidecar after a successful
 * transcription; there is no transcriber until Slice 2, so this deletes after a
 * successful *read* and Slice 2 moves the delete point later in this same
 * handler once transcription sits in front of it. Audio bytes never cross the
 * transport — a path is small and a WAV is not.
 *
 * Deleting only after the size is known is what makes the supervisor's sweep
 * meaningful: a file still on disk at restart is one whose reader died, which
 * is the only way an orphan is produced.
 */
async function readAudio(params: unknown): Promise<AudioReadResult> {
  const path = audioPathFrom(params);
  const { size } = await stat(path);
  await unlink(path);
  return { bytes: size, deleted: true };
}

function audioPathFrom(params: unknown): string {
  const path = (params as { path?: unknown } | null)?.path;
  if (typeof path !== "string" || path === "") throw new Error("readAudio requires a path");
  return path;
}

/**
 * Exits on request, so the supervisor's restart and backoff paths are testable
 * without sending signals — a test that kills by signal is testing the
 * operating system, and on Windows it is testing something else entirely.
 */
function exitNow(params: unknown): never {
  const code = (params as { code?: unknown } | null)?.code;
  process.exit(typeof code === "number" ? code : 0);
}
