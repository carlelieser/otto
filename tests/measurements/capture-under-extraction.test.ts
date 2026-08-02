import { describe, expect, it } from "vitest";
import { CaptureExtraction } from "../../src/application/pipeline/extract-capture.js";
import { createIngestion, createStorage, type Storage } from "../../src/composition-root.js";
import type { Extraction, Extractor } from "../../src/ports/extractor.js";
import { aCapture } from "../support/builders.js";

/**
 * Capture stays responsive while a long extraction runs (`qa.md` §8) — the
 * Slice 2 test, now with real load behind it.
 *
 * **This is the test that guards the entire process-model decision**
 * (`runtime.md` §1). ADD §4 puts the pipeline outside the WebView so that a
 * busy extractor is not a stuttering capture window, and §1 rejects running the
 * pipeline in the WebView on exactly this argument. If capture blocks behind a
 * local model, that decision bought nothing.
 *
 * It is in the default run rather than in `*.local.test.ts` because the
 * property is structural, not a timing: extraction is `await`ed I/O, so
 * ingestion must interleave with it. A real model would make this slower and no
 * more conclusive — what would break it is an extractor doing synchronous CPU
 * work on the same thread, and a fake that never yields catches that better
 * than a real one that does.
 */

/** Long enough that a serialised implementation cannot finish inside it. */
const EXTRACTION_MS = 300;

/**
 * The bar for a single capture taken while extraction is in flight. Generous,
 * because the point is to catch a capture that waits for extraction rather than
 * to grade the storage layer, which `capture-latency.local.test.ts` does.
 */
const CAPTURE_BAR_MS = 100;

/**
 * An extractor that takes a long time and yields while it does — which is what
 * a real one does, since it is waiting on a socket.
 */
class SlowExtractor implements Extractor {
  async extract(): Promise<Extraction> {
    await new Promise((resolve) => setTimeout(resolve, EXTRACTION_MS));
    return { mentions: [], violations: [], provider: "slow", modelVersion: "test" };
  }
}

describe("capture under extraction load", () => {
  it("stays responsive while a long extraction is in flight", async () => {
    const storage: Storage = createStorage();
    const extraction = new CaptureExtraction(new SlowExtractor(), storage.proposals, () =>
      new Date().toISOString(),
    );
    const ingestion = createIngestion(storage);

    const running = extraction.extract(aCapture());

    const started = performance.now();
    const captured = await ingestion.ingest({
      source: "typed",
      rawText: "A thought taken while the pipeline is busy.",
      sourceTimestamp: "2026-08-03T09:00:00.000Z",
      transcriptionModel: null,
    });
    const elapsed = performance.now() - started;

    await running;
    storage.close();

    expect(captured.captureId).toMatch(/^cap-/);
    expect(elapsed).toBeLessThan(CAPTURE_BAR_MS);
    // The assertion that makes the previous one mean something: the capture
    // completed *during* the extraction rather than after it. Without this, an
    // implementation that serialised the two would still pass whenever the
    // machine was fast enough to do both inside the bar.
    expect(elapsed).toBeLessThan(EXTRACTION_MS);
  });

  /**
   * A saturated pipeline degrades to "captures accumulate" (`add.md` §11), which
   * is a state the system already handles — and the reason it is survivable is
   * that the captures are durable while it happens.
   */
  it("durably stores every capture taken while extraction runs", async () => {
    const storage: Storage = createStorage();
    const extraction = new CaptureExtraction(new SlowExtractor(), storage.proposals, () =>
      new Date().toISOString(),
    );
    const ingestion = createIngestion(storage);

    const running = extraction.extract(aCapture());
    const captures = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        ingestion.ingest({
          source: "typed",
          rawText: `Thought number ${n}.`,
          sourceTimestamp: "2026-08-03T09:00:00.000Z",
          transcriptionModel: null,
        }),
      ),
    );
    await running;

    for (const capture of captures) {
      expect(await storage.captures.get(capture.captureId)).not.toBeNull();
    }
    storage.close();
  });
});
