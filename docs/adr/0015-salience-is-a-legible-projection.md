# Salience is a legible projection, and v0 ships crude on purpose

---
Status: accepted
---

The PRD long named salience the largest undesigned area of the product, and correctly said it blocks brief quality rather than brief existence. Briefs are in MVP scope, so something must select their contents. The full v0 is in [`salience.md`](../salience.md); two decisions inside it are architectural rather than product tuning.

**Salience is a projection, computed from the log, and never accumulated state.** This is the load-bearing claim, and it is what makes shipping a crude v0 safe. Because the score is derived, replacing the rules is a rebuild rather than a migration, and v0 and v1 rankings can be compared over the same history. If salience were accumulated — a counter incremented on each mention, decayed by a job — every rule change would be a migration with no ground truth to migrate from, and the least-known part of the product would be the part most expensive to change. It lives in `inference/salience/` rather than `domain/`, because "how much does this deserve attention now" fails ADR-0002's survival test, and consistently with that directory's rule it computes a ranking and writes nothing (ADR-0003).

**The score is a legible sum of named terms, not a learned model.** `recency + open_loop + imminence + attention_debt − dormancy`, each term readable and attributable. The point of v0 is to generate the observations that produce v1, and a score a human can read and say "that term is wrong" does that; a learned ranking at single-user data volume does not, and forfeits the property that makes it improvable. v1 may change weights, add terms, and use the graph — it may not become unreadable.

v0's known failures are written down in `salience.md` §3 rather than left to be discovered: uniform decay across entity types, recency dominating importance, no model of what the user has already looked at, no periodicity, and almost no use of relations. Instrumentation ships with v0 — which entities appeared in each brief, which the user then opened, and which they opened that no brief surfaced — giving a passive precision-and-recall signal with no feedback UI to build.

**Brief composition follows the same selection-precedes-generation rule as the rest of the pipeline** (ADD §8). Sections are capped, empty sections are omitted rather than padded, and the generator cannot introduce entities that were not selected — the same constraint extraction operates under (ADR-0007), for the same reason. A brief with nothing to say says so in one line; manufacturing content on a quiet day teaches the user to skim, which is how the feature dies.

## Considered Options

- **Defer briefs out of MVP until salience is understood** — rejected: PRD §8's success criteria depend on Otto surfacing things back, and an MVP that only ingests never demonstrates the value it exists to prove.
- **Accumulated salience state with a decay job** — rejected above; the migration trap.
- **Learn ranking from user behaviour** — rejected for v0 on data volume and legibility grounds. Available to v1 once the instrumentation has run.
- **Summarise the week's raw Captures instead of selecting from the knowledge base** — rejected: it is a harder and worse-grounded job, and it discards the structure the whole write path exists to build.

## Consequences

- **v0 will produce mediocre briefs for some weeks.** This is accepted and bounded — the cost of a bad ranking is a few unhelpful lists, and the architecture guarantees it leaves no residue.
- Recency dominating is the most likely first complaint and the most likely first fix.
- Brief instrumentation means recording what the user opened, which is behavioural data about the user. It stays local like everything else (PRD §4.6) and is derived, so it can be dropped.
- Once written, a brief is not regenerated. It records what mattered that day, and Otto does not rewrite history anywhere else either.
