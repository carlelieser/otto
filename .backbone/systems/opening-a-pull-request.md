---
system: Opening a pull request
status: unvalidated
created: 2026-08-02
depends-on:
  - reviewing-code.md
---

# Opening a pull request

## Purpose

A pull request serves two purposes at once, and both are required.

It is the **synthesis layer**: a durable record of one unit of work, written for a
reader who arrives months later with no memory of it and no access to the
discussion that produced it.

It is the **discipline gate**: the checkpoint every change passes through before
reaching the default branch. The gate is self-imposed and nobody enforces it from
outside. That is the reason it is written down.

The two purposes conflict on timing. A record is written after the work settles;
a gate must be satisfied before the merge. The procedure below resolves this by
running code review **before** the pull request is created, so the body is
written once, with the review's findings already in hand.

## What the body must contain

Four sections are required in every pull request.

1. **Why the work exists.** The problem, the specification, or the defect that
   caused it. A reader must be able to establish the motivation without opening
   another document, though links belong here.
2. **What changed.** The substance of the work, described so that a reader
   understands the result without reading the diff.
3. **The judgment calls.** Every choice inside the work that could reasonably
   have gone another way, and why it went this way. An invented value, a chosen
   threshold, a rejected alternative.
4. **How it was verified.** What was run, what it covered, and what it did not.

## Optional sections and their triggers

Each optional section has a trigger condition. A section is included when its
trigger fires and omitted when it does not. This is not a matter of preference.

| Section             | Trigger                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Scope boundaries    | The work deliberately left something unbuilt that a reader could mistake for an oversight |
| Review findings     | The review pass found a defect, and it was fixed or explicitly declined                   |
| Known gaps          | Something is knowingly incomplete or wrong and is being merged regardless                 |
| Pre-existing issues | The work surfaced a defect it did not cause and did not fix                               |
| Descoped            | Something the specification asked for was deliberately not delivered                      |

### Escape hatch

A section outside this catalogue may be added when the work produced a finding
that a later reader needs and no listed trigger covers. This is the only
permitted extension. A section added for any other reason — padding, symmetry,
habit — is a defect.

## Style and tone

The body is documentation and follows the documentation rules: professional, low
complexity, clear. No meta commentary. No casual text.

**Register is neutral.** State what changed. Do not advocate for it.

**Uncertainty is explicit.** Where the work is uncertain, invented, or
unverified, say so plainly. A value chosen without derivation is named as
invented. A behaviour believed correct but untested is named as untested.

**Failures are recorded.** A test that passed against a bug, an approach
abandoned partway, a fix that took three attempts — these belong in the body.
This is the material with the highest value to a later reader and the lowest rate
of survival. Omitting it produces a record that reads as uniformly competent and
is therefore untrustworthy.

**No unexplained shorthand, and no references to conversations.** The reader has
neither. Terms specific to this work are defined or linked on first use.

**Claims carry their evidence.** Numbers, not adjectives. "1,303 lines across 13
files" rather than "a substantial change". "412 tests, 47 new" rather than "well
tested". Every number is measured before it is written.

## Procedure

### 1. Pre-flight

Both must hold before code review begins.

- **Local verification is green.** `npm run verify` passes.
  `npm run build:sidecar` has run, followed by
  `cargo test --manifest-path src-tauri/Cargo.toml`, and both pass. The sidecar
  build precedes the Rust suite because its integration tests drive a spawned
  sidecar.
- **The diff obeys the written rules.** `AGENTS.md` and `~/.claude/engineering.md`
  — method and class limits, naming, error handling, one logical change per
  commit, every commit a working state. This is the author's own check, not a
  substitute for the rules axis of review.

Sending a diff to review with the mechanical gates red spends the review pass on
breakage that a local command would have caught.

### 2. Review the changes

Follow `reviewing-code.md`. Its subject is the diff, not the pull request, which
does not exist yet.

### 3. Address every finding

Per `reviewing-code.md`: hard violations are fixed, judgment calls are fixed or
declined on one of its four grounds. Fixes are new commits, typed per
Conventional Commits. Existing commits are not amended.

If any fix changed code that executes, re-run the review before continuing.

### 4. Write the body

To the standard above, with the review's findings in hand.

Every claim must be true at this point. Each number was measured after the last
fix landed — verification counts in particular, which change whenever tests are
added. No claim is carried over from a previous pull request or written from
memory. The review output in `.backbone/scratch/` is the source for the findings
section; it is not written from recollection.

### 5. Open the pull request

### 6. Confirm continuous integration is green

Both jobs: `verify` and `host`.

### 7. Merge

The decision is the author's, informed by the review. The review advises; it does
not decide.

## Failure modes this system exists to prevent

- A pull request that only makes sense to someone who was present for the work.
- A review pass spent reporting mechanical breakage.
- A body written before its own review findings are known, and amended afterwards
  until the two disagree.
- A record that reads as uniformly successful because the failures were removed.
- Changes reaching the default branch without passing through a gate, because the
  gate is self-imposed and nobody outside enforces it.

## Validation

**This system is unvalidated.** It was reasoned out in full but has never been
executed. Its first run is its first test, and any step that proves unworkable in
practice is a defect in this document rather than a step to be skipped.

Record the outcome of the first execution here.
