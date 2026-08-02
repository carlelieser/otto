import type { SalienceCoefficients } from "../../inference/salience/coefficients.js";
import type { BriefKind } from "../../inference/salience/brief-selection.js";
import { selectDaily } from "../../inference/salience/select-daily.js";
import { selectWeekly } from "../../inference/salience/select-weekly.js";
import type { BriefStore, BriefWriteResult } from "../../ports/brief-store.js";
import type { BriefGenerator } from "../../ports/brief-generator.js";
import type { EventStore } from "../../ports/event-store.js";
import { readSalientEntities } from "./read-salient-entities.js";
import { BriefWriting } from "./write-brief.js";

/**
 * A brief, end to end: fold the log, score it, select, generate, store
 * (`salience.md` §4, ADD §8).
 *
 * The sequence ADD §8 specifies, in the layer it says owns it — "composition is
 * an application-layer sequence: select by salience, group, and pass to an LLM
 * for prose". Each stage is a module that could be tested alone; this is the
 * only thing that knows their order.
 *
 * Nothing here decides *what* is salient. That is `inference/salience/`'s, which
 * writes nothing (ADR-0003) — this reads the log, hands it over, and stores the
 * answer.
 */
export class BriefProduction {
  readonly #events: EventStore;
  readonly #writing: BriefWriting;
  readonly #coefficients: SalienceCoefficients | undefined;

  constructor(dependencies: BriefProductionDependencies) {
    this.#events = dependencies.events;
    this.#writing = new BriefWriting(dependencies.briefs, dependencies.generator);
    this.#coefficients = dependencies.coefficients;
  }

  /**
   * The brief covering the window ending at `now`, composed if there is not
   * already one for that date.
   *
   * Idempotent by the same mechanism the log is: the id is derived from the
   * kind and the date, so a scheduler that fires twice writes once
   * (`write-brief.ts`).
   */
  async produce(kind: BriefKind, now: string): Promise<BriefWriteResult> {
    const { entities, relations } = await readSalientEntities(this.#events, now);
    const select = kind === "daily" ? selectDaily : selectWeekly;
    return this.#writing.write(select(entities, relations, now, this.#coefficients), now);
  }
}

export interface BriefProductionDependencies {
  /** The log, which is where every salience input comes from (ADR-0015). */
  readonly events: EventStore;
  readonly briefs: BriefStore;
  readonly generator: BriefGenerator;
  /**
   * The coefficients to score against, defaulting to v0.
   *
   * Injectable so a v1 ranking can be produced over the same log and compared
   * against v0's — the payoff ADR-0015 says the architecture was buying.
   */
  readonly coefficients?: SalienceCoefficients;
}
