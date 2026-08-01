import { defineConfig } from "vitest/config";

/**
 * The default run is everything a clean checkout can execute.
 *
 * `*.local.test.ts` is the exception, and the rule governing it is narrow: a
 * test leaves the default run only when it depends on something a clean
 * checkout does not have — a `whisper.cpp` build and its model, a recorded
 * corpus, or a known machine class whose timings mean anything. Everything in
 * `qa.md` §4 stays in, since Tier 0 is what a commit must not break.
 *
 * They are excluded rather than merely slow-tagged because CI would otherwise
 * go red the moment the transcriber landed, and the usual fix for a red CI is
 * deleting the test. `npm run test:local` runs them on demand.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/**/*.local.test.ts"],
    environment: "node",
  },
});
