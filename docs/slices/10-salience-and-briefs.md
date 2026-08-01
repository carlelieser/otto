# Slice 10 — Salience and briefs

> Depends on: Slice 6. Independent of Slices 8 and 9.
> Sources: [`prd.md`](../prd.md) §5.7; [`add.md`](../add.md) §8; [`salience.md`](../salience.md) (all); [`qa.md`](../qa.md) §11; ADR-0015.

## What it closes

Otto surfaces what deserves attention on a cadence: a daily brief readable in under two minutes, and a weekly one about what moved and what didn't. This is the last third of the MVP loop — capture, knowledge base, **surfaced back**.

## Why here

It needs projections (Slice 6) and nothing else. It is independent of the review queue's downstream slices, so it can be built in parallel with merge and transcript correction.

**It ships knowingly crude, and that is the design** (ADR-0015). Briefs cannot wait for usage data that only shipping produces. What makes shipping a crude version safe is that salience is derived: replacing the rules is a rebuild rather than a migration, and there is no accumulated state to be wrong. The cost of a bad v0 is a few weeks of mediocre briefs; the cost of waiting is no briefs at all.

## In scope

**Salience as a projection**, in `inference/salience/`, writing nothing. This is the load-bearing architectural claim in the area of the product least likely to survive contact with use (ADR-0015). It lives in `inference/` rather than `domain/` because it fails ADR-0002's test: delete Otto and "how much does this deserve attention now" stops being a question anyone asks.

**The v0 score** (`salience.md` §2), a legible sum of named terms on a 0–100 scale — no decay curve fitting, no learned weights, no embeddings:

```
salience = recency + open_loop + imminence + attention_debt − dormancy
```

Each term is specified with its coefficients in `salience.md` §2. Two worth restating: **`attention_debt`** surfaces the thing the user has quietly stopped thinking about, which is the one thing a system like this can do that the user cannot do for themselves. And **Person salience is derived from association rather than scored directly** — the maximum salience of the Projects, Tasks, and Events they relate to, plus their own `recency`. People are salient because something involving them is.

**Legibility as a requirement, not a preference.** A score a human cannot read and argue with is not improvable at this data volume. v1 may change weights, add terms, add per-type decay, and use the graph — what it may not do is become unreadable.

**Daily and weekly brief composition** (`salience.md` §4), selection first. Sections and caps are specified there; **empty sections are omitted rather than padded**, because a brief that manufactures content on a quiet day teaches the user to skim. If everything is empty, the brief says so in one line — a legitimate output.

**Generation.** One LLM call per brief, given the selected entities as structured data. **The generator cannot introduce entities that were not selected** — the same constraint the differ places on extraction, for the same reason. Patterns noticed across the week are left to the generator with no requirement to produce something: a forced insight is worse than none.

**Briefs are stored and not regenerated.** A brief is a record of what mattered on that day, and rewriting history is not something Otto does anywhere else either. Surfaced in the dashboard rather than pushed, with a tray badge indicating a new brief is waiting.

**The instrumentation that replaces v0** (`salience.md` §5), shipping *with* v0 rather than after it: which entities appeared in each brief, which of those the user then opened, and which high-salience entities the user opened without a brief having surfaced them. A precision and recall signal for the selection rules, gathered passively with no feedback UI.

**The known failures, written down** (`salience.md` §3) — everything decays at the same rate, recency dominates, nothing models the user's own attention, no notion of periodicity, relations barely contribute. These are documented predictions, and the instrumentation exists to check which of them actually matter.

## Not in scope

- **Brief customisation and delivery outside the app.** Post-MVP (PRD §7.2).
- **Salience v1.** By construction. The path from v0 to v1 is a measurement, not a redesign.
- **Push notifications.** Briefs are surfaced in the dashboard; the tray badge is the only signal.
- **Any use of embeddings in salience.** v0 is arithmetic over named terms.

## Build order

1. The salience projection — the five terms, each independently testable.
2. Person salience by association.
3. Daily selection: four sections, caps, omission of empties.
4. Weekly selection: five sections, caps.
5. Generation over selected structured data, with the no-new-entities constraint.
6. Storage, the dashboard surface, and the tray badge.
7. The v0→v1 instrumentation.

## Verification

`qa.md` §11 is specific about what is and is not testable here.

**Testable as arithmetic** (Tier 1 treatment): given a fixture entity with a known mention date, status, and due date, the score is a number, and **each term is tested in isolation**. Selection likewise: given a fixture knowledge base, which entities land in which section, that caps hold, and that empty sections are omitted.

**The architectural commitment, tested separately and mattering more than either**: salience is a projection, recomputable from history, writing nothing. **Changing the rules and recomputing produces a new ranking from the same log.** That property is the entire reason salience was made a projection, and it is what makes v0's expected replacement cheap.

**Not testable, and not pretended otherwise**: whether the rules are *right*. That is a product question no test answers, and `salience.md` §5 addresses it with instrumentation instead.

**Brief generation stays smoke-level** (`qa.md` §10, §11): a brief generates, is non-empty, and **contains no entity that was not selected**. The selection beneath it gets ordinary Tier 1 treatment.

## Done when

- Every salience term is independently tested and the composite score is assertable from fixtures.
- Changing a coefficient and recomputing produces a new ranking over the same log with no migration.
- Daily and weekly briefs generate, omit empty sections, and introduce no unselected entity.
- The v0→v1 instrumentation records brief contents and subsequent opens.
