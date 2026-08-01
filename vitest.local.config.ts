import { defineConfig } from "vitest/config";

/**
 * The measurements and the one integration test, run on demand.
 *
 * These need a local `whisper.cpp` build, its model, a recorded corpus, or a
 * known machine class — none of which a shared runner has, and a shared
 * runner's timings are noise besides. `OTTO_WHISPER_BIN` and `OTTO_WHISPER_MODEL`
 * point at the build; a test whose dependency is absent skips rather than
 * fails, so this config is runnable anywhere even when it does nothing.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.local.test.ts"],
    environment: "node",
    // Transcription is not fast, and the latency runs take a fixed number of
    // iterations. The default 5 s timeout would fail them for being real.
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
