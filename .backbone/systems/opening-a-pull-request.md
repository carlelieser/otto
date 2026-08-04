---
system: Opening a pull request
status: validated
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
| Known gaps          | Something is knowingly incomplete or wrong and is being merged regardless                 |
| Pre-existing issues | The work surfaced a defect it did not cause and did not fix                               |
| Descoped            | Something the specification asked for was deliberately not delivered                      |

### The body describes the final state, never the route to it

There is no section for review findings, and adding one is a defect. A defect
that was found and fixed is not part of the work; the fixed code is. A reader
arriving later needs to know how the system behaves now, and is misled by a
narrative of what it did before the last commit.

A finding reaches the body only where it describes something still true at
merge — which the triggers above already cover. A declined finding that leaves a
standing gap is a known gap. One that belongs to different work is a
pre-existing issue. One that is fixed leaves nothing to say.

The same rule governs everything else the body might narrate: an approach
abandoned partway, a fix that took three attempts, a test that passed against a
bug. Where such a thing changed what the code now is — a rejected alternative
that explains the design — it belongs under the judgment calls, stated as a
property rather than as a history. Where it did not, it belongs in the commit
log and nowhere else.

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

**Weaknesses that survive to the merge are stated.** A behaviour known to be
wrong, a test that cannot catch what it appears to cover, a bound that is a guess
— these belong in the body, because they are true of the code being merged. This
is the material with the highest value to a later reader and the lowest rate of
survival. Omitting it produces a record that reads as uniformly competent and is
therefore untrustworthy.

This is not licence to narrate. A weakness is stated as a present property of the
work, not as an account of the trouble it caused on the way. Failures that were
resolved leave no trace in the body; the commit log holds them.

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
memory. Where a declined finding leaves a standing weakness, the review output in
`.backbone/scratch/` is the source for it; it is not written from recollection.

Then read the body back against the style section before publishing it. Writing
to those rules does not reliably produce a body that obeys them.

### 5. Open the pull request

### 6. Confirm continuous integration is green

Both jobs: `verify` and `host`.

### 7. Merge

The decision is the author's, informed by the review. The review advises; it does
not decide.

## Failure modes this system exists to prevent

- A pull request that only makes sense to someone who was present for the work.
- A review pass spent reporting mechanical breakage.
- A body written before the review's findings are known, and amended afterwards
  until the code and the record disagree.
- A record that hides a weakness the merged code still carries.
- A record that recounts the work's history instead of describing its result.
- Changes reaching the default branch without passing through a gate, because the
  gate is self-imposed and nobody outside enforces it.

## Validation

**First executed on Slice 12** (pull request #23, merged). The procedure held.
Four defects in this document surfaced and are corrected above.

**The body must describe the final state, not the route to it.** The optional
sections included a trigger for review findings, which produced a body narrating
defects that no longer existed. The trigger is removed and the rule is stated
explicitly, because a section heading is an invitation.

**"Failures are recorded" was too broad.** It read as licence to narrate the
work's history and is now limited to weaknesses that survive to the merge.

**Both required a second pass to enforce.** The first body was written to this
document and still contained meta commentary, process narration, and a casual
register. The style section names those faults; naming them was not enough to
prevent them. A body is now read back against this section before it is
published, not only written from it.

**The pull request state is re-read before any commit is added to its branch.**
A commit was pushed to a branch whose pull request had already merged, stranding
it. Step 7 ends the procedure; work after it starts a new one.

Nothing in the procedure proved unworkable. The pre-flight gate caught a
non-working commit before review, and the review caught a defect that the test
suite did not.
