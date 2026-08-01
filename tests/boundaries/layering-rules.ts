import type { SourceFile } from "./source-files.js";

/**
 * The four layering rules of `add.md` §3, as data.
 *
 * Rules 1-3 are import rules (ADR-0001, ADR-0003); rule 4 is the `confidence`
 * grep that guards the domain/machinery distinction (ADR-0002). `qa.md` §4.1
 * requires all four to fail the build rather than warn.
 */
export interface LayeringRule {
  readonly name: string;
  readonly appliesTo: (path: string) => boolean;
  /** `from` is the importing file's path relative to `src/`. */
  readonly forbids: (specifier: string, from: string) => boolean;
}

/** The one module permitted to import `infrastructure/` (ADR-0001). */
export const COMPOSITION_ROOT = "composition-root.ts";

const FORBIDDEN_TO_INFERENCE = ["ports/event-store", "ports/capture-store", "application/"];

function isRepositoryPort(specifier: string): boolean {
  return specifier.includes("ports/") && specifier.includes("repository");
}

export const IMPORT_RULES: readonly LayeringRule[] = [
  {
    name: "no module under inference/ imports a repository port, the event store port, or application/",
    appliesTo: (path) => path.startsWith("inference/"),
    forbids: (specifier, from) => {
      const target = resolveSpecifier(specifier, from);
      return (
        isRepositoryPort(target) ||
        FORBIDDEN_TO_INFERENCE.some((forbidden) => target.startsWith(forbidden))
      );
    },
  },
  {
    name: "domain/ imports nothing else in src/",
    appliesTo: (path) => path.startsWith("domain/"),
    forbids: (specifier, from) => isInternal(specifier) && !isWithinDomain(specifier, from),
  },
  {
    // An infrastructure module importing its siblings is internal cohesion,
    // not a layering violation; the rule is about who reaches *into* the layer.
    name: "only the composition root imports infrastructure/",
    appliesTo: (path) => path !== COMPOSITION_ROOT && !path.startsWith("infrastructure/"),
    forbids: (specifier, from) => resolveSpecifier(specifier, from).startsWith("infrastructure/"),
  },
];

/**
 * `domain/` may import its own siblings, so the target layer decides, not the
 * specifier's shape: `../values/x.js` from `domain/events/` stays inside
 * `domain/`, while `../../ports/x.js` leaves it.
 */
function isWithinDomain(specifier: string, from: string): boolean {
  return resolveSpecifier(specifier, from).startsWith("domain/");
}

/** A specifier resolved to a path relative to `src/`, mirroring Node resolution. */
export function resolveSpecifier(specifier: string, from: string): string {
  if (!specifier.startsWith(".")) return specifier.replace(/^src\//, "");
  const fromDirectory = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  return normalisePath(`${fromDirectory}/${specifier}`);
}

function normalisePath(path: string): string {
  const resolved: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join("/");
}

function isInternal(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("src/");
}

const IMPORT_PATTERN = /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g;

/** Every module specifier a file imports or re-exports from. */
export function importedSpecifiers(file: SourceFile): string[] {
  return [...file.text.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? "");
}

export interface Violation {
  readonly rule: string;
  readonly path: string;
  readonly specifier: string;
}

/** Every violation of `rule` across `files`. Empty means the boundary holds. */
export function findViolations(
  rule: LayeringRule,
  files: readonly SourceFile[],
): readonly Violation[] {
  return files
    .filter((file) => rule.appliesTo(file.path))
    .flatMap((file) =>
      importedSpecifiers(file)
        .filter((specifier) => rule.forbids(specifier, file.path))
        .map((specifier) => ({ rule: rule.name, path: file.path, specifier })),
    );
}

/**
 * The one module under `domain/` allowed to say `confidence`.
 *
 * Provenance is a record *about* Otto's machinery rather than a piece of
 * knowledge, and `add.md` §10 requires the event row to carry "the confidence
 * at the time" as part of it. Rule 4 is about knowledge and the application
 * policy — "the domain policy is asked about a *kind of change*, never about a
 * number" — so a provenance record storing one is the rule's subject matter,
 * not its violation.
 *
 * The exemption is one file wide on purpose. Anything else under `domain/`
 * naming a confidence is the erosion the rule exists to catch.
 */
const PROVENANCE_MODULE = "domain/values/provenance.ts";

/**
 * Files under `domain/` that mention `confidence` in any casing.
 *
 * `add.md` §3's fourth rule is not mechanically checkable in general, but its
 * most likely violation is: a knowledge type or a policy that reads a number
 * it should never see.
 */
export function findConfidenceMentions(files: readonly SourceFile[]): readonly string[] {
  return files
    .filter((file) => file.path.startsWith("domain/"))
    .filter((file) => file.path !== PROVENANCE_MODULE)
    .filter((file) => /confidence/i.test(file.text))
    .map((file) => file.path);
}
