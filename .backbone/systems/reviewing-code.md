---
system: Reviewing code
status: unvalidated
created: 2026-08-04
invoked-by:
  - opening-a-pull-request.md
---

# Reviewing code

## Purpose

Code review examines **a set of changes** against four axes before those changes
are proposed for merge. Its subject is the diff. It does not review a pull
request body, and it runs before a pull request exists.

The review advises. It does not decide. The author decides what to fix, what to
decline, and when to merge.

## Self-containment

This system borrows vocabulary and technique from two skills that exist outside
the repository: `code-review` and `improve-codebase-architecture`. It does not
depend on either being present. Everything required to run a review is written
here.

## Position in the sequence

Review runs after the work is complete and before the pull request is created.

```
work complete → review → findings addressed → pull request opened
```

Running review after the pull request exists would mean the body is written
before its own findings are known, and then amended. Running it before means the
body is written once, after the work has settled, with the findings already in
hand.

## The four axes

Each axis is examined by its own sub-agent, running in parallel, with no shared
context. Isolation is the point: an agent that has already accepted a design
rationale will not then flag the rule violation that rationale explains away.

| Axis            | Checks                                                                                                                                                                                                                         | Against                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rules**       | Method length ≤ 10 lines, class ≤ 100 lines, file ≤ 300 lines, ≤ 3 parameters, ≤ 3 levels of nesting, ≤ 2 boolean operators per condition, naming, error handling, one logical change per commit, every commit a working state | `AGENTS.md`, `~/.claude/engineering.md`                                                                                                                             |
| **Correctness** | Logic errors, unhandled edge cases, tests that would pass against a broken implementation, missing regression tests                                                                                                            | The code itself. The specification is supplied as context so that deliberate behaviour is not misread as a defect, but conformance to it is not this axis's subject |
| **Intent**      | Requirements missing or partially implemented, behaviour nobody asked for, requirements implemented incorrectly                                                                                                                | The slice specification in `docs/slices/`, or the originating issue                                                                                                 |
| **Design**      | Shallow modules, leaky seams, poor locality, the twelve smells below, opportunities to reduce complexity                                                                                                                       | The deletion test, and the vocabulary below                                                                                                                         |

### Rules applying to every axis

- **Skip what tooling enforces.** Formatting, type errors, lint failures, and
  test failures are caught by `npm run verify`, `cargo fmt`, `cargo clippy`, and
  the test suites before review begins. A finding about any of them is wasted
  attention.
- **Label hard violations and judgment calls separately.** A breach of a written
  rule is hard. A smell, a design observation, or a stylistic preference is a
  judgment call. The author cannot triage findings that do not say which they
  are.
- **Quote the code and cite the source.** A rules finding cites the rule it
  breaches. An intent finding quotes the specification line. A finding without
  both is not checkable and should not be reported.

## The design axis

### Vocabulary

Design findings use these terms and no substitutes. Precision here is what keeps
the axis from degrading into preference.

- **Module** — a unit with an interface and an implementation behind it.
- **Interface** — what a caller must understand to use the module.
- **Depth** — the ratio of implementation hidden to interface exposed. A deep
  module hides much behind little. A shallow one exposes nearly as much as it
  implements.
- **Seam** — a boundary where one part can be replaced without the other
  noticing.
- **Leverage** — how much a change at one point achieves elsewhere.
- **Locality** — whether the things that change together sit together.

### The deletion test

Applied to anything suspected of being shallow: would deleting this module
concentrate complexity somewhere useful, or merely move it elsewhere? A module
whose deletion concentrates complexity was earning its place. One whose deletion
merely relocates it was not.

### The smell baseline

Twelve smells, each read as _what it is_ → _how to fix it_. Every one is a
judgment call, never a hard violation. A documented repository standard always
wins where the two conflict.

- **Mysterious name** — a function, variable, or type whose name does not reveal
  what it does or holds. → Rename it. If no honest name presents itself, the
  design is unclear.
- **Duplicated code** — the same logical shape in more than one place in the
  change. → Extract the shape, call it from both.
- **Feature envy** — a method that reaches into another object's data more than
  its own. → Move the method to the data it envies.
- **Data clumps** — the same few fields or parameters travelling together. → A
  type wanting to be born. Bundle them and pass that.
- **Primitive obsession** — a primitive or string standing in for a domain
  concept. → Give the concept its own small type.
- **Repeated switches** — the same conditional cascade on the same type,
  recurring. → Replace with polymorphism, or one shared map.
- **Shotgun surgery** — one logical change forcing scattered edits across many
  files. → Gather what changes together into one module.
- **Divergent change** — one module edited for several unrelated reasons. →
  Split it so each module changes for one reason.
- **Speculative generality** — abstraction, parameters, or hooks added for needs
  that do not exist. → Delete it. Inline it back until a real need appears.
- **Message chains** — long navigation the caller should not depend on. → Hide
  the walk behind one method.
- **Middle man** — a module that mostly delegates onward. → Remove it, call the
  target directly.
- **Refused bequest** — an implementer that ignores most of what it inherits. →
  Drop the inheritance, use composition.

### Simplification

Where the same result can be achieved with less, the review says so and shows
the simpler form. A finding that names a simpler alternative is actionable. One
that expresses a structural preference without producing an alternative is not,
and should not be reported.

### Severity

A design finding blocks the pull request **only when it is actionable within the
diff's existing scope**. A finding larger than that — a restructuring the change
did not cause and cannot reasonably absorb — is recorded in the pull request body
under known gaps or scope, or raised as an architecture decision record, and does
not gate the merge.

Without this rule, the design axis becomes the reason work stops merging.

## Output

The review writes one file to `.backbone/scratch/`, which is not committed. The
durable record of what review found is the pull request body; this file is the
working artifact that feeds it.

It persists after the pull request is opened. If a finding was transcribed into
the body incorrectly, this file is the only way to detect that.

### Required contents

For **each of the four axes, kept separate**:

1. **Coverage** — what was examined, and against what. A review reporting no
   findings without stating its coverage is indistinguishable from a review that
   did not happen, and is treated as a failed review to be re-run.
2. **Findings** — each quoting the code, citing its source, and labelled hard
   violation or judgment call.

An empty findings list with stated coverage is a valid result.

### Findings are not merged or reranked

The four axes are reported separately and stay that way. Ranking findings across
axes lets a strong result on one axis mask a failure on another, which is the
outcome the separation exists to prevent.

## Addressing findings

Every finding is either fixed or declined.

### Hard violations must be fixed

A breach of a written rule in `AGENTS.md` or `~/.claude/engineering.md` cannot be
declined. The rules were agreed in writing; an argument for an exception is an
argument to change the rule, which belongs in an architecture decision record or
an edit to the rules themselves.

`engineering.md` permits exceeding a threshold with a justification stated when
the code is written. That is not a ground for declining a review finding after
the fact. The two are different acts.

### Judgment calls may be declined on four grounds

- **Incorrect** — the reviewer misread the code. State what it actually does.
- **Out of scope** — the finding is real but belongs to different work. It is
  then recorded in the pull request body under known gaps, or raised as an
  architecture decision record.
- **Deliberate** — the code is that way on purpose. State the purpose.
- **Disagreement** — a judgment call the author rejects, with reasoning.

A finding fitting none of these four is fixed.

Declinations are recorded in the pull request body, not only in a reply. A
finding raised and left unaddressed reads to a later reader as an oversight
unless the body says otherwise.

### Fixes

Each fix is a new commit, typed per Conventional Commits. Existing commits are
not amended. The log showing that review found something and that it was
corrected is the honest record.

### Re-review

If any fix changed code that executes, re-run the review. Fixes confined to
documentation or formatting do not require it.

The trigger is checkable rather than a matter of judgment: did any fix change
code that runs?

## Failure modes this system exists to prevent

- A review that reports nothing and cannot be distinguished from one that did not
  happen.
- One axis passing strongly and masking another's failure.
- A design finding with no actionable alternative blocking work indefinitely.
- A written rule quietly waived by declining the finding that caught it.
- Findings that exist only in a session and are gone when the body is written.

## Validation

**This system is unvalidated.** It was reasoned out in full but has never been
executed. Its first run is its first test, and any step that proves unworkable in
practice is a defect in this document rather than a step to be skipped.

Record the outcome of the first execution here.
