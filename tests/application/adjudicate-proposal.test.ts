import { beforeEach, describe, expect, it } from "vitest";
import { ProposalAdjudication } from "../../src/application/pipeline/adjudicate-proposal.js";
import { Executor } from "../../src/application/pipeline/execute-command.js";
import { SET_FIELD } from "../../src/domain/commands/knowledge-commands.js";
import { HUMAN_PROVIDER } from "../../src/domain/values/provenance.js";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteCorrectionStore } from "../../src/infrastructure/persistence/sqlite-correction-store.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import { SqliteReviewQueueStore } from "../../src/infrastructure/persistence/sqlite-review-queue-store.js";
import { ALL_TRANSLATORS } from "../../src/composition-root.js";
import type { CorrectionStore } from "../../src/ports/correction-store.js";
import type { EventStore } from "../../src/ports/event-store.js";
import type { QueuedProposal, ReviewQueueStore } from "../../src/ports/review-queue-store.js";
import { aCommand, aProposal } from "../support/triage-builders.js";

let events: EventStore;
let queue: ReviewQueueStore;
let corrections: CorrectionStore;
let adjudication: ProposalAdjudication;

const AT = "2026-08-02T09:00:00.000Z";

beforeEach(async () => {
  const database = openDatabase();
  events = new SqliteEventStore(database);
  queue = new SqliteReviewQueueStore(database);
  corrections = new SqliteCorrectionStore(database);
  adjudication = new ProposalAdjudication({
    executor: new Executor(events, ALL_TRANSLATORS, () => AT),
    queue,
    corrections,
    currentVersionOf: (aggregateId) => events.currentVersion(aggregateId),
    now: () => AT,
  });
});

function anEntry(overrides: Partial<QueuedProposal> = {}): QueuedProposal {
  return {
    proposal: aProposal(),
    disposition: "needs_review",
    confidence: 0.72,
    wasSampled: false,
    adjudicatedAt: null,
    queuedAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

async function queued(overrides: Partial<QueuedProposal> = {}): Promise<QueuedProposal> {
  const entry = anEntry(overrides);
  await queue.put([entry]);
  return entry;
}

describe("confirming a queued Proposal", () => {
  it("applies the Proposal's own Command", async () => {
    await queued();

    await adjudication.confirm(aProposal().proposalId);

    const [stored] = await events.readForward(0, 10);
    expect(stored?.type).toBe("EntityCreated");
    expect(stored?.aggregate.id).toBe("per-sarah");
  });

  /**
   * PRD §5.4: correcting is one action from the queue, and confirming is too.
   * The arity is the assertion — a confirm needing the entity, the Command, or
   * anything the caller has to look up first would not be one action.
   */
  it("is one action, taking only the Proposal id", async () => {
    await queued();

    expect(adjudication.confirm).toHaveLength(1);
    await expect(adjudication.confirm(aProposal().proposalId)).resolves.toBeUndefined();
  });

  /** The confirmed change is a human's, and provenance says so (`qa.md` §7.5). */
  it("records the change as human-confirmed", async () => {
    await queued();

    await adjudication.confirm(aProposal().proposalId);

    const [stored] = await events.readForward(0, 10);
    expect(stored?.provenance.isHumanConfirmed).toBe(true);
    expect(stored?.provenance.provider).toBe(HUMAN_PROVIDER);
  });

  /** The Proposal it came from stays named, so the trail survives. */
  it("keeps the Proposal and Capture on the provenance", async () => {
    await queued();

    await adjudication.confirm(aProposal().proposalId);

    const [stored] = await events.readForward(0, 10);
    expect(stored?.provenance.proposalId).toBe("prop-1");
    expect(stored?.provenance.captureId).toBe("cap-1");
  });

  it("leaves the queue entry readable and stamped", async () => {
    await queued();

    await adjudication.confirm(aProposal().proposalId);

    const entry = await queue.get(aProposal().proposalId);
    expect(entry?.adjudicatedAt).toBe(AT);
  });

  it("refuses a Proposal the queue does not hold", async () => {
    await expect(adjudication.confirm("prop-nothing")).rejects.toThrow(/prop-nothing/);
  });

  /** Confirming is not correcting: there is no counterfactual to record. */
  it("records no correction", async () => {
    await queued();

    await adjudication.confirm(aProposal().proposalId);

    expect(await corrections.all()).toEqual([]);
  });
});

describe("correcting a queued Proposal", () => {
  const CHOSEN = aCommand({
    type: SET_FIELD,
    aggregate: { type: "Entity", id: "per-other-sarah", expectedVersion: 0 },
    payload: { field: "employer", value: "Globex" },
  });

  /** ADR-0006: the Sarah the user chose, attached to the Proposal and the Capture. */
  it("records what the user chose instead", async () => {
    await queued();

    await adjudication.correct(aProposal().proposalId, CHOSEN);

    const [stored] = await corrections.forProposal("prop-1");
    expect(stored?.chosen.aggregate.id).toBe("per-other-sarah");
    expect(stored?.chosen.payload).toEqual({ field: "employer", value: "Globex" });
  });

  it("attaches the correction to the Proposal and the Capture behind it", async () => {
    await queued();

    await adjudication.correct(aProposal().proposalId, CHOSEN);

    const [stored] = await corrections.forProposal("prop-1");
    expect(stored?.proposalId).toBe("prop-1");
    expect(stored?.captureId).toBe("cap-1");
  });

  /** The counterfactual is the whole point; a rejection flag is what it is not. */
  it("records the chosen Command rather than a rejection", async () => {
    await queued();

    await adjudication.correct(aProposal().proposalId, CHOSEN);

    const [stored] = await corrections.forProposal("prop-1");
    expect(Object.keys(stored ?? {})).not.toContain("rejected");
    expect(stored?.chosen).toBeDefined();
  });

  it("applies the chosen Command rather than the Proposal's", async () => {
    await queued();

    await adjudication.correct(aProposal().proposalId, CHOSEN);

    const [stored] = await events.readForward(0, 10);
    expect(stored?.type).toBe("FieldSet");
    expect(stored?.aggregate.id).toBe("per-other-sarah");
  });

  /** `add.md` §7: the correction is a human's change, and provenance says so. */
  it("records the corrected change as human-confirmed", async () => {
    await queued();

    await adjudication.correct(aProposal().proposalId, CHOSEN);

    const [stored] = await events.readForward(0, 10);
    expect(stored?.provenance.isHumanConfirmed).toBe(true);
    expect(stored?.provenance.confidence).toBeNull();
  });

  it("counts toward the bootstrap counter for the Proposal's model", async () => {
    await queued();

    await adjudication.correct(aProposal().proposalId, CHOSEN);

    expect(await corrections.countForModel("local", "qwen2.5-7b-instruct")).toBe(1);
  });

  it("stamps the queue entry as adjudicated", async () => {
    await queued();

    await adjudication.correct(aProposal().proposalId, CHOSEN);

    expect((await queue.get(aProposal().proposalId))?.adjudicatedAt).toBe(AT);
  });

  it("refuses a Proposal the queue does not hold", async () => {
    await expect(adjudication.correct("prop-nothing", CHOSEN)).rejects.toThrow(/prop-nothing/);
  });
});

/**
 * `qa.md` §7.7 and `add.md` §7: **the correction path issues a Command directly
 * to the executor and does not re-enter the pipeline.**
 *
 * Asserted structurally in `tests/inference/command-seam.test.ts` — that no
 * extractor is reachable from this module — and behaviourally here, since the
 * structural test proves nothing could call one and this proves nothing did.
 */
describe("the correction path does not re-enter the pipeline", () => {
  /** A correction produces exactly one event: no re-extraction, no re-diff. */
  it("appends one event and no more", async () => {
    await queued();

    await adjudication.correct(aProposal().proposalId, aCommand());

    expect(await events.readForward(0, 10)).toHaveLength(1);
  });
});

/**
 * `add.md` §10 and `qa.md` §7.7: corrections append, never edit. Nothing is
 * deleted and history stays intact, which is what makes "why does Otto think
 * this?" answerable months later.
 */
describe("corrections append rather than edit", () => {
  /**
   * The slice's "auto-applied changes are visible in the queue **and
   * correctable**". The chosen Command carries `expectedVersion: 0` — what a
   * caller reading the queue would build, since `QueueEntryView` exposes no
   * version — and correcting still works, because the correction path restamps
   * against the target's current version.
   */
  it("leaves an auto-applied event in place and appends the correction on top", async () => {
    const applied = anEntry({ disposition: "auto_apply" });
    await queue.put([applied]);
    await adjudication.confirm(applied.proposal.proposalId);

    const chosen = aCommand({
      type: SET_FIELD,
      aggregate: { type: "Entity", id: "per-sarah", expectedVersion: 0 },
      payload: { field: "employer", value: "Globex" },
    });
    await adjudication.correct(applied.proposal.proposalId, chosen);

    const log = await events.readForward(0, 10);
    expect(log.map((event) => event.type)).toEqual(["EntityCreated", "FieldSet"]);
  });

  it("keeps every correction of a Proposal rather than replacing the last", async () => {
    await queued();
    await adjudication.correct(
      aProposal().proposalId,
      aCommand({ type: SET_FIELD, payload: { field: "employer", value: "Acme" } }),
    );
    await adjudication.correct(
      aProposal().proposalId,
      aCommand({ type: SET_FIELD, payload: { field: "employer", value: "Globex" } }),
    );

    expect(await corrections.forProposal("prop-1")).toHaveLength(2);
  });

  /** A double-submitted correction is one row and one event, not two. */
  it("is idempotent for the identical correction", async () => {
    await queued();

    await adjudication.correct(aProposal().proposalId, CHOSEN_TWICE);
    await adjudication.correct(aProposal().proposalId, CHOSEN_TWICE);

    expect(await corrections.forProposal("prop-1")).toHaveLength(1);
    expect(await events.readForward(0, 10)).toHaveLength(1);
  });
});

const CHOSEN_TWICE = aCommand({
  type: SET_FIELD,
  payload: { field: "employer", value: "Acme" },
});
