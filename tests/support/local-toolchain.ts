import { existsSync } from "node:fs";

/**
 * Where the local `whisper.cpp` build is, if there is one.
 *
 * The measurements and the one integration test need a real binary and a real
 * model, which a clean checkout does not have. They are already excluded from
 * the default run; this lets them *skip* rather than fail when run on demand on
 * a machine that has not built whisper yet, so `npm run test:local` is
 * meaningful everywhere.
 *
 * Both paths are configurable because `runtime.md` §2 offers `large-v3` as an
 * optional download, and swapping models must stay a path change.
 */
export interface WhisperInstallation {
  readonly binaryPath: string;
  readonly modelPath: string;
}

const BINARY_VARIABLE = "OTTO_WHISPER_BIN";
const MODEL_VARIABLE = "OTTO_WHISPER_MODEL";

/** The configured installation, or `null` when either half is missing. */
export function findWhisper(): WhisperInstallation | null {
  const binaryPath = process.env[BINARY_VARIABLE];
  const modelPath = process.env[MODEL_VARIABLE];
  if (binaryPath === undefined || modelPath === undefined) return null;
  if (!existsSync(binaryPath) || !existsSync(modelPath)) return null;
  return { binaryPath, modelPath };
}

/** Why a suite skipped, for a message that says what to set rather than just "skipped". */
export const WHISPER_MISSING = `set ${BINARY_VARIABLE} and ${MODEL_VARIABLE} to a whisper.cpp build`;
