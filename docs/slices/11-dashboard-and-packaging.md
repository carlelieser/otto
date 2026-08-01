# Slice 11 — Dashboard and packaging

> Depends on: Slices 6 and 7; surfaces everything built before it.
> Sources: [`prd.md`](../prd.md) §5.2, §5.3, §7.1; [`add.md`](../add.md) §6, §7; [`stack.md`](../stack.md) §6, §8; [`qa.md`](../qa.md) §10, §13.

## What it closes

Otto becomes an application the user installs and lives in: a sidebar, list views, entity detail pages with relations and visible provenance, and an installer that works on first launch with no network.

This is the slice that makes the previous ten a product.

## Why here

Last, because it is the one slice that has to see all the others. Every surface it presents is a read against something built earlier, and building the shell before the surfaces exist means building it twice.

`qa.md` §10 is deliberately the thinnest section of the test plan, and §12 puts UI smoke and the two E2E paths last and "kept small." The UI is where bugs are most visible and least costly; E2E tests are the most expensive per unit of confidence. That ranking is the reason this slice's verification is lighter than its size suggests.

## In scope

**The dashboard shell** (PRD §5.2): a sidebar for navigating between notes and each of the five entity types, and a main area listing them with search, sorting, and filtering.

**Entity detail views** (PRD §5.3) — where the knowledge base pays off. A Person shows what Otto knows about them, the projects they're involved in, the events they were at, open follow-ups, and when the user last had contact. A Project shows its status, its next action, who's involved, and its history. This is the difference between a pile of notes and a knowledge base: the user asks about one thing and gets everything connected to it, assembled from notes written weeks apart that never mentioned each other.

**Provenance visible on every fact** (PRD §7.1, `add.md` §7). Every field can name the note it came from, and through it the Proposal, model and version, confidence, and whether a human confirmed it. The projection built this pointer in Slice 6; this slice renders it.

**Date precision rendered honestly** (`schema.md` §8). A `quarter`-precision date displays as "Q3" and never as a specific day. `relative_unresolved` keeps its phrase and is excluded from anything time-ordered.

**The review queue and brief surfaces**, given their place in the navigation rather than existing as bare working screens.

**Staleness handled in the local view.** An applied event is treated as immediately true rather than blocking on the projection catching up (`add.md` §6). This is the one non-obvious UI behaviour and it gets real tests.

**Packaging per platform** (`stack.md` §6, §8). The installer carries `whisper.cpp`, the embedding model, and the SQLite-Vector native extension per target — roughly 650 MB before Otto's own code, accepted because working offline on first launch is worth more than a small download. The Node sidecar ships alongside the Tauri binary.

**Closing `stack.md` §8's remaining open rows**: the build and packaging pipeline, the Svelte version and UI dependencies, and how the sidecar's Node runtime *ships* — Slice 2 settled the development answer (the host spawns an installed Node, behind a configurable interpreter path) and left the bundled runtime here, which this slice substitutes without rewriting the supervisor. (The test framework closed in Slice 0; the SQLite driver in Slice 0–1; the Rust toolchain and Tauri version in Slice 2; SQLite-Vector's licence in Slice 4.)

**Cross-platform smoke**: the application launches, the tray works, and the hotkey binds on macOS, Windows, and Linux.

## Not in scope

- **Mobile or web clients.** Post-MVP (PRD §7.2).
- **Semantic search over notes.** Post-MVP. Full-text search from Slice 6 is what ships.
- **Rich text, wiki links, page hierarchy.** Excluded by PRD §6 — notes are captures, not documents.
- **User-defined tags, folders, or any taxonomy.** Excluded by PRD §6. If the user has to file something, Otto has failed.
- **Auto-update infrastructure.** Not specified anywhere in the MVP scope.

## Build order

1. Application shell, sidebar, and routing across notes and the five entity types.
2. List views with search, sort, and filter.
3. Entity detail views with relations.
4. Provenance rendering, and date-precision-aware date display.
5. Review queue and brief surfaces placed in the navigation.
6. Staleness handling in the local view.
7. Packaging per platform, with the three native artefacts bundled.
8. Cross-platform launch, tray, and hotkey smoke.

## Verification

Tier 4 (`qa.md` §10) — smoke plus targeted cases around staleness:

**Staleness gets real tests**, being the one non-obvious behaviour: approve a proposal, assert the UI reflects it immediately, assert it still reflects it after the projection catches up, and assert it does not double-apply or flicker.

**Smoke coverage** for tray capture (voice and typed), dashboard navigation across all five entity types plus notes, list search/sort/filter, entity detail with relations and provenance, review queue with confirm and correct, and the daily and weekly brief surfaces.

**E2E, and only these two** — every E2E test must justify why it cannot be an integration test:

- Tray hotkey to durable Capture (the three-process integration).
- Review-queue adjudication to applied event (the full write path through the UI) — inherited from Slice 7.

**Accessibility and cross-platform are smoke-level.** Otto is single-user desktop software; browser matrices do not apply.

## Done when — and the MVP release criteria

This slice's exit condition is `qa.md` §13 in full, because when it passes, Otto ships:

- Every lint rule in `qa.md` §4.1 passes. **Not negotiable** — these encode ADR-0003.
- Tier 0 and Tier 1 are green with **no skipped tests**. A skipped destructive-change test is a release blocker.
- Eval set metrics have not regressed against the previous release, per provider and model version. **A regression is a hold, not a warning** — without this the pipeline rots silently.
- **The local path clears the §6.3 floor.** Since local is the default (ADR-0016), this gates the shipped experience rather than an alternative one.
- **The suite is green with no provider configured.** A release that only passes with cloud credentials present has not been tested in its default configuration.
- No performance measurement is in the fail column; measurements in the warning band are recorded.
- The two E2E paths pass.

And the standing rule the whole plan points at: **a test asserting Otto declined to act is as important as one asserting Otto acted.** The failure this system dies of is not a crash. It is a confidently wrong change the user believed.
