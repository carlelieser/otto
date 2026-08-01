import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { Transcriber, Transcript } from "../../ports/transcriber.js";

const run = promisify(execFile);

/**
 * `-np` suppresses everything that is not a result; `-nt` drops the timestamps.
 * Together they make stdout the transcript and nothing else.
 */
const QUIET_TEXT_ONLY = ["--no-prints", "--no-timestamps"] as const;

/** How `whisper.cpp` names its model files: `ggml-<model>.bin`. */
const MODEL_FILE_PATTERN = /^ggml-(.+)\.bin$/;

export interface WhisperCliOptions {
  /** The `whisper-cli` executable. */
  readonly binaryPath: string;
  /** The `ggml-*.bin` model file, e.g. `ggml-small.en.bin`. */
  readonly modelPath: string;
  /** Spawns the process. Injected so the adapter is testable without a binary. */
  readonly spawn?: SpawnProcess;
}

/** Runs a command and returns what it wrote to stdout. */
export type SpawnProcess = (
  binaryPath: string,
  args: readonly string[],
) => Promise<{ stdout: string }>;

/**
 * `whisper.cpp` behind the `Transcriber` port, by shelling out to
 * `whisper-cli` rather than through a Node native binding (`stack.md` §8).
 *
 * A native binding buys in-process speed that a port taking a file path cannot
 * use anyway, and costs a compiled dependency rebuilt per Node version and per
 * platform — on top of `better-sqlite3`, which is already one. Shelling out
 * also keeps the adapter honest: everything it needs is behind the
 * `Transcriber` signature, and swapping the binary for `large-v3` is a path
 * change rather than a code change (`runtime.md` §2).
 *
 * This is the adapter, so it lives in `infrastructure/` and only the
 * composition root constructs it.
 */
export class WhisperCliTranscriber implements Transcriber {
  readonly #binaryPath: string;
  readonly #modelPath: string;
  readonly #spawn: SpawnProcess;

  constructor(options: WhisperCliOptions) {
    this.#binaryPath = options.binaryPath;
    this.#modelPath = options.modelPath;
    this.#spawn = options.spawn ?? defaultSpawn;
  }

  /**
   * Transcribes the recording, returning its text verbatim.
   *
   * Only the leading and trailing newline the CLI frames its output with are
   * stripped — the transcript's own whitespace is left alone, because
   * `content_hash` covers the raw text and normalisation happens later by a
   * pure function.
   */
  async transcribe(audioPath: string): Promise<Transcript> {
    const stdout = await this.#runCli(audioPath);
    return { text: stripFraming(stdout), model: this.#modelName() };
  }

  async #runCli(audioPath: string): Promise<string> {
    const args = ["--model", this.#modelPath, "--file", audioPath, ...QUIET_TEXT_ONLY];
    try {
      const { stdout } = await this.#spawn(this.#binaryPath, args);
      return stdout;
    } catch (cause) {
      throw new Error(`Transcribing ${audioPath} with ${this.#modelPath} failed`, { cause });
    }
  }

  /**
   * The model name exactly as `whisper.cpp` names it, taken from the model
   * file: `ggml-small.en.bin` is `small.en`.
   *
   * Derived rather than configured so the recorded name cannot drift from the
   * file that produced it — the two would disagree the first time someone
   * points the adapter at a different model without updating a label.
   */
  #modelName(): string {
    const fileName = basename(this.#modelPath);
    const match = MODEL_FILE_PATTERN.exec(fileName);
    if (match?.[1] === undefined) {
      throw new Error(`Model path ${this.#modelPath} is not a ggml-<model>.bin file`);
    }
    return match[1];
  }
}

/** The CLI wraps its output in a leading newline and a trailing space. */
function stripFraming(stdout: string): string {
  return stdout.replace(/^\n/, "").replace(/[ \n]+$/, "");
}

function defaultSpawn(binaryPath: string, args: readonly string[]): Promise<{ stdout: string }> {
  return run(binaryPath, [...args]);
}
