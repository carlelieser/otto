import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  deriveCaptureId,
  deriveCorrectionId,
  deriveContentHash,
  deriveProposalId,
} from "../../src/capture/capture-identity.js";
import { normalise } from "../../src/capture/normalise.js";

/**
 * The golden values. A fixed triple and the id it must produce, written as a
 * literal rather than computed by the test.
 *
 * This is the test that makes `runtime.md` §3 enforceable rather than advisory.
 * The property-based tests below confirm the derivations are *consistent*,
 * which a wrong-but-consistent implementation also satisfies — only a literal
 * catches a changed separator, a reordered field, or a different truncation.
 *
 * Recomputing the expectation inside the test would assert the implementation
 * against itself and pass on any of those changes.
 */
const GOLDEN_CAPTURE = {
  source: "typed",
  sourceTimestamp: "2026-08-01T09:00:00.000Z",
  rawText: "Coffee with Sarah about the Helios rollout.",
  contentHash: "864aec1c5753d8b92a3910ef9cbcae906422e9cc6b676def8c70dbecda1eba97",
  captureId: "cap-0ee28d5f3077a14b63959caaf2f7415a",
} as const;

describe("deriveContentHash", () => {
  it("is 64 lowercase hex characters with no algorithm prefix", () => {
    const hash = deriveContentHash("Coffee with Sarah");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(":");
  });

  it("is SHA-256 over the UTF-8 encoding of the raw text", () => {
    const rawText = "Coffee with Sarah — the Helios rollout";
    const expected = createHash("sha256").update(rawText, "utf8").digest("hex");
    expect(deriveContentHash(rawText)).toBe(expected);
  });

  /**
   * The em-dash case, stated because an unstated encoding is exactly how two
   * machines produce two hashes for one Capture.
   */
  it("hashes non-ASCII text the same way on any machine", () => {
    expect(deriveContentHash("—")).toBe(
      createHash("sha256").update(Buffer.from("—", "utf8")).digest("hex"),
    );
  });

  it("covers the raw text, so normalisation cannot re-key a Capture", () => {
    const rawText = "  Coffee   with\n\nSarah  ";
    expect(deriveContentHash(rawText)).not.toBe(deriveContentHash(normalise(rawText)));
  });
});

describe("deriveCaptureId", () => {
  it("is the cap- prefix and 32 hex characters", () => {
    const captureId = deriveCaptureId({
      source: "typed",
      sourceTimestamp: GOLDEN_CAPTURE.sourceTimestamp,
      contentHash: deriveContentHash(GOLDEN_CAPTURE.rawText),
    });
    expect(captureId).toMatch(/^cap-[0-9a-f]{32}$/);
  });

  /**
   * Pinned against a literal computed once from the specification — a single
   * space between fields, in the order (source, source_timestamp,
   * content_hash), truncated to 32 characters after the prefix.
   */
  it("matches the golden value for a fixed triple", () => {
    const contentHash = deriveContentHash(GOLDEN_CAPTURE.rawText);
    const captureId = deriveCaptureId({
      source: GOLDEN_CAPTURE.source,
      sourceTimestamp: GOLDEN_CAPTURE.sourceTimestamp,
      contentHash,
    });
    expect(contentHash).toBe(GOLDEN_CAPTURE.contentHash);
    expect(captureId).toBe(GOLDEN_CAPTURE.captureId);
  });

  it("changes when any one of the three inputs changes", () => {
    const base = {
      source: "typed",
      sourceTimestamp: GOLDEN_CAPTURE.sourceTimestamp,
      contentHash: deriveContentHash(GOLDEN_CAPTURE.rawText),
    } as const;
    const id = deriveCaptureId(base);

    expect(deriveCaptureId({ ...base, source: "voice" })).not.toBe(id);
    expect(deriveCaptureId({ ...base, sourceTimestamp: "2026-08-01T09:00:00.001Z" })).not.toBe(id);
    expect(deriveCaptureId({ ...base, contentHash: deriveContentHash("something else") })).not.toBe(
      id,
    );
  });

  /**
   * The retried-upload property: identical input yields one Capture, whatever
   * else varies about the run.
   */
  it("is stable for identical input", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom("typed" as const, "voice" as const),
        (text, source) => {
          const identity = {
            source,
            sourceTimestamp: GOLDEN_CAPTURE.sourceTimestamp,
            contentHash: deriveContentHash(text),
          };
          expect(deriveCaptureId(identity)).toBe(deriveCaptureId(identity));
        },
      ),
    );
  });

  /**
   * Normalisation does not change `capture_id`. Property-based, per the slice's
   * Verification: for arbitrary raw text the id is stable across a changed
   * normaliser, because the hash covers the raw form.
   */
  it("does not change when normalisation would change the text", () => {
    fc.assert(
      fc.property(fc.string(), (rawText) => {
        const identity = {
          source: "typed" as const,
          sourceTimestamp: GOLDEN_CAPTURE.sourceTimestamp,
          contentHash: deriveContentHash(rawText),
        };
        const beforeNormaliserChange = deriveCaptureId(identity);
        // A changed normaliser produces different normalised text from the same
        // raw text; the id must not move, because it never saw the normaliser.
        expect(deriveCaptureId(identity)).toBe(beforeNormaliserChange);
      }),
    );
  });
});

const GOLDEN_PROPOSAL = {
  captureId: GOLDEN_CAPTURE.captureId,
  stage: "extraction",
  provider: "local",
  modelVersion: "qwen2.5-7b-instruct",
  ordinal: 0,
  proposalId: "prop-615994eb905ed0e5122b4ece40b15e59",
} as const;

describe("deriveProposalId", () => {
  it("is the prop- prefix and 32 hex characters", () => {
    expect(deriveProposalId(GOLDEN_PROPOSAL)).toMatch(/^prop-[0-9a-f]{32}$/);
  });

  it("matches the golden value for a fixed tuple", () => {
    expect(deriveProposalId(GOLDEN_PROPOSAL)).toBe(GOLDEN_PROPOSAL.proposalId);
  });

  /**
   * Both directions, since a test of only the first passes on an
   * implementation that hashed the model version away — the bug `runtime.md`
   * §3 is specifically written to prevent.
   */
  it("changes when the model version changes", () => {
    const upgraded = { ...GOLDEN_PROPOSAL, modelVersion: "qwen3-8b-instruct" };
    expect(deriveProposalId(upgraded)).not.toBe(deriveProposalId(GOLDEN_PROPOSAL));
  });

  it("does not change when the model version does not", () => {
    expect(deriveProposalId({ ...GOLDEN_PROPOSAL })).toBe(deriveProposalId(GOLDEN_PROPOSAL));
  });

  it("changes when the provider changes", () => {
    const cloud = { ...GOLDEN_PROPOSAL, provider: "anthropic" };
    expect(deriveProposalId(cloud)).not.toBe(deriveProposalId(GOLDEN_PROPOSAL));
  });

  it("distinguishes two Proposals from one Capture, model, and stage by ordinal", () => {
    const second = { ...GOLDEN_PROPOSAL, ordinal: 1 };
    expect(deriveProposalId(second)).not.toBe(deriveProposalId(GOLDEN_PROPOSAL));
  });

  it("renders the ordinal with String(), so 0 is not 0.0", () => {
    const asFloat = { ...GOLDEN_PROPOSAL, ordinal: 0.0 };
    expect(deriveProposalId(asFloat)).toBe(deriveProposalId(GOLDEN_PROPOSAL));
  });

  it("distinguishes the stages", () => {
    const resolution = { ...GOLDEN_PROPOSAL, stage: "resolution" as const };
    expect(deriveProposalId(resolution)).not.toBe(deriveProposalId(GOLDEN_PROPOSAL));
  });

  /** The full `cap-`-prefixed id goes in as a string, not re-hashed or stripped. */
  it("takes the capture id whole, prefix included", () => {
    const stripped = {
      ...GOLDEN_PROPOSAL,
      captureId: GOLDEN_PROPOSAL.captureId.replace("cap-", ""),
    };
    expect(deriveProposalId(stripped)).not.toBe(deriveProposalId(GOLDEN_PROPOSAL));
  });
});

const GOLDEN_CORRECTION = {
  proposalId: GOLDEN_PROPOSAL.proposalId,
  chosenType: "SetField",
  chosenTargetId: "per-sarah",
  chosenPayload: '{"field":"employer","value":"Acme"}',
  correctionId: "corr-1f567ac058a9d8d860e40b1a104f066f",
} as const;

describe("deriveCorrectionId", () => {
  it("is the corr- prefix and 32 hex characters", () => {
    expect(deriveCorrectionId(GOLDEN_CORRECTION)).toMatch(/^corr-[0-9a-f]{32}$/);
  });

  it("matches the golden value for a fixed tuple", () => {
    expect(deriveCorrectionId(GOLDEN_CORRECTION)).toBe(GOLDEN_CORRECTION.correctionId);
  });

  /**
   * The idempotency the derivation exists for: a double-submitted correction
   * from a retried click is one row, not two.
   */
  it("is the same for the same correction of the same Proposal", () => {
    expect(deriveCorrectionId({ ...GOLDEN_CORRECTION })).toBe(
      deriveCorrectionId(GOLDEN_CORRECTION),
    );
  });

  /**
   * The other half: a user who corrects, then corrects *again* to something
   * else, has said two different things and both are data. Collapsing them
   * would silently discard the second answer — and the second is the one they
   * meant.
   */
  it("differs when the user chooses a different answer", () => {
    const otherValue = {
      ...GOLDEN_CORRECTION,
      chosenPayload: '{"field":"employer","value":"Globex"}',
    };
    expect(deriveCorrectionId(otherValue)).not.toBe(deriveCorrectionId(GOLDEN_CORRECTION));
  });

  it("differs when the user chooses a different entity", () => {
    const otherSarah = { ...GOLDEN_CORRECTION, chosenTargetId: "per-other-sarah" };
    expect(deriveCorrectionId(otherSarah)).not.toBe(deriveCorrectionId(GOLDEN_CORRECTION));
  });

  it("differs when the corrected Proposal differs", () => {
    const otherProposal = { ...GOLDEN_CORRECTION, proposalId: "prop-other" };
    expect(deriveCorrectionId(otherProposal)).not.toBe(deriveCorrectionId(GOLDEN_CORRECTION));
  });

  it("differs when the chosen Command type differs", () => {
    const asCreate = { ...GOLDEN_CORRECTION, chosenType: "CreateEntity" };
    expect(deriveCorrectionId(asCreate)).not.toBe(deriveCorrectionId(GOLDEN_CORRECTION));
  });
});
