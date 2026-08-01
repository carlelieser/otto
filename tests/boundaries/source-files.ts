import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const SRC_ROOT = resolve(import.meta.dirname, "../../src");

export interface SourceFile {
  /** Path relative to `src/`, always with forward slashes. */
  readonly path: string;
  readonly text: string;
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = entries.map(async (entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(absolute);
    return entry.name.endsWith(".ts") ? [absolute] : [];
  });
  return (await Promise.all(nested)).flat();
}

/** Every `.ts` file under `src/`, addressed by its path relative to `src/`. */
export async function readSourceFiles(): Promise<SourceFile[]> {
  const absolutePaths = await listTypeScriptFiles(SRC_ROOT);
  return Promise.all(absolutePaths.map(readSourceFile));
}

async function readSourceFile(absolutePath: string): Promise<SourceFile> {
  return {
    path: relative(SRC_ROOT, absolutePath).replaceAll("\\", "/"),
    text: await readFile(absolutePath, "utf8"),
  };
}

/** A violating fixture, addressed as though it lived at `pretendPath` inside `src/`. */
export async function readViolatingFixture(
  fixtureName: string,
  pretendPath: string,
): Promise<SourceFile> {
  const absolute = resolve(import.meta.dirname, "../fixtures/violations", fixtureName);
  return { path: pretendPath, text: await readFile(absolute, "utf8") };
}
