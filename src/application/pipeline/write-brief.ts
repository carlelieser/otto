import type { BriefKind, BriefSelection } from "../../inference/salience/brief-selection.js";
import type { BriefGenerator } from "../../ports/brief-generator.js";
import type { BriefStore, BriefWriteResult, StoredBrief } from "../../ports/brief-store.js";
import { localDateOf } from "../schedule/local-time.js";
import { composeBrief } from "./compose-brief.js";

/**
 * Compose a brief and store it, once (`salience.md` §4).
 *
 * The one place the two halves meet: selection and generation produce a brief,
 * and this decides whether it is written. **A brief already stored for that
 * date wins**, because "a brief is not regenerated once written" — it records
 * what mattered that day under the rules in force that day, and a second run
 * next month under different coefficients would produce a different and equally
 * true brief that overwrote the first.
 *
 * The existing brief is checked before generating rather than after, so a
 * repeated run costs no model call at all.
 */
export class BriefWriting {
  readonly #briefs: BriefStore;
  readonly #generator: BriefGenerator;

  constructor(briefs: BriefStore, generator: BriefGenerator) {
    this.#briefs = briefs;
    this.#generator = generator;
  }

  /**
   * The brief for the window `selection` covers: the stored one if there is
   * one, otherwise a newly composed one.
   */
  async write(selection: BriefSelection, generatedAt: string): Promise<BriefWriteResult> {
    const briefId = briefIdFor(selection.kind, selection.coversTo);
    const existing = await this.#briefs.byId(briefId);
    if (existing !== undefined) return { brief: existing, wasStored: false };
    return this.#briefs.put(await this.#compose(briefId, selection, generatedAt));
  }

  async #compose(
    briefId: string,
    selection: BriefSelection,
    generatedAt: string,
  ): Promise<StoredBrief> {
    const { prose, provider, modelVersion } = await composeBrief(selection, this.#generator);
    const kind = selection.kind;
    return { briefId, kind, selection, prose, provider, modelVersion, generatedAt, readAt: null };
  }
}

/**
 * A brief's id: its kind and the date it covers.
 *
 * Derived rather than random, which is what makes "one brief per day, never
 * rewritten" the table's primary key rather than a rule someone enforces. Two
 * runs on the same day compute the same id and the second insert does nothing —
 * the same idempotency substrate the event log uses (`runtime.md` §3).
 *
 * **The date is local rather than UTC**, which is the one place in the system
 * an instant is not reduced to UTC when it crosses a boundary. A brief is about
 * the user's day: at a positive UTC offset the 06:00 trigger fires while UTC is
 * still on the previous date, so a UTC-derived id would name the day before the
 * one the brief covers — and, because the id is also the idempotency key, would
 * then collide with the next morning's brief (`local-time.ts`).
 */
export function briefIdFor(kind: BriefKind, coversTo: string): string {
  return `${kind}-${localDateOf(coversTo)}`;
}
