import type { DomainEvent } from "./domain-event.js";

/** Rewrites one version of a payload shape into the next. */
export type Upcast = (payload: unknown) => unknown;

/** A registered upcast: from this (type, version) to the next version. */
export interface UpcastEntry {
  readonly type: string;
  readonly fromVersion: number;
  readonly upcast: Upcast;
}

export class MissingUpcastError extends Error {
  constructor(
    readonly type: string,
    readonly version: number,
  ) {
    super(
      `Cannot upcast event of type ${type} at version ${version}: ` +
        `no upcast path to the current shape`,
    );
    this.name = "MissingUpcastError";
  }
}

/**
 * Maps (type, version) to the upcast that carries it forward one version.
 *
 * `add.md` §6 makes event versioning permanent discipline: payload shapes are
 * never changed in place, a new shape is a new version with an upcast from the
 * old, and upcasting happens at *read* time so the log is never migrated
 * (ADR-0011). This registry is the mechanism; today it holds one identity
 * upcast, because the version field and this seam cost nothing at event type #1
 * and are a log migration at event type #20.
 *
 * The cost, stated plainly in ADR-0011: **upcast functions accumulate and can
 * never be deleted.** `qa.md` §4.5 keeps someone from quietly stopping paying it.
 */
export class UpcastRegistry {
  readonly #upcasts = new Map<string, Upcast>();
  readonly #currentVersions = new Map<string, number>();

  constructor(entries: readonly UpcastEntry[] = []) {
    for (const entry of entries) this.register(entry);
  }

  register({ type, fromVersion, upcast }: UpcastEntry): void {
    this.#upcasts.set(keyFor(type, fromVersion), upcast);
    const known = this.#currentVersions.get(type) ?? fromVersion;
    this.#currentVersions.set(type, Math.max(known, fromVersion));
  }

  /** Declares the version an event type's payload is currently written at. */
  declareCurrentVersion(type: string, version: number): void {
    const known = this.#currentVersions.get(type) ?? version;
    this.#currentVersions.set(type, Math.max(known, version));
  }

  currentVersion(type: string): number | undefined {
    return this.#currentVersions.get(type);
  }

  /** Whether every version from `version` to current has a registered upcast. */
  hasUpcastPath(type: string, version: number): boolean {
    const current = this.#currentVersions.get(type);
    if (current === undefined || version > current) return false;
    return this.#versionsBetween(version, current).every((step) =>
      this.#upcasts.has(keyFor(type, step)),
    );
  }

  /**
   * An event rewritten into the current shape, applying each upcast in turn.
   * An event already at the current version passes through untouched.
   */
  upcastToCurrent(event: DomainEvent): DomainEvent {
    const current = this.#currentVersions.get(event.type);
    if (current === undefined || event.version > current) {
      throw new MissingUpcastError(event.type, event.version);
    }

    const payload = this.#versionsBetween(event.version, current).reduce(
      (carried, step) => this.#applyStep(event.type, step, carried),
      event.payload,
    );
    return { ...event, version: current, payload };
  }

  #applyStep(type: string, fromVersion: number, payload: unknown): unknown {
    const upcast = this.#upcasts.get(keyFor(type, fromVersion));
    if (upcast === undefined) throw new MissingUpcastError(type, fromVersion);
    return upcast(payload);
  }

  /** The versions needing an upcast to reach `current`: [from, current). */
  #versionsBetween(from: number, current: number): number[] {
    const steps: number[] = [];
    for (let version = from; version < current; version += 1) steps.push(version);
    return steps;
  }

  /** Every registered (type, version), for the test that none were deleted. */
  registeredVersions(): readonly { type: string; fromVersion: number }[] {
    return [...this.#upcasts.keys()].map(parseKey);
  }
}

function keyFor(type: string, version: number): string {
  return `${type}@${version}`;
}

function parseKey(key: string): { type: string; fromVersion: number } {
  const separator = key.lastIndexOf("@");
  return {
    type: key.slice(0, separator),
    fromVersion: Number(key.slice(separator + 1)),
  };
}

/** Leaves a payload exactly as it is; the shape did not change. */
export const identityUpcast: Upcast = (payload) => payload;
