# Slice 3 — Resolution and the differ

> Depends on: Slice 2. Blocks: Slice 4.
> Sources: [`add.md`](../add.md) §5.3, §5.4; [`schema.md`](../schema.md); [`triage.md`](../triage.md) §1; [`runtime.md`](../runtime.md) §2, §4.3; [`qa.md`](../qa.md) §7.2, §7.3; ADR-0007, ADR-0009, ADR-0010, ADR-0014.

## What it closes

A Mention becomes a decision about which entity it refers to — or that it refers to none — and the difference between what the note says and what Otto currently believes becomes a set of Commands. The knowledge model exists from this slice on: Person, Project, Idea, Event, Task, and the closed relation vocabulary.

Commands are produced but not applied. Slice 4 decides what happens to them.

## Why here

Resolution is the only stage that reads current knowledge (`add.md` §5.3), so it needs entities to exist — and the differ is what creates them. The two are one slice because neither is demonstrable alone: resolution with no differ produces a decision nothing consumes, and a differ with no resolution has nothing to compare against.

This is also the slice where `schema.md` stops being a document and becomes data the differ reads. Cardinality, extractability, and per-field floors are read from the schema rather than implemented as logic (`add.md` §5.4).

## In scope

**The knowledge model** — the five entity types with their typed fields, exactly as `schema.md` §2–§5 enumerates. Entities carry fields (ADR-0010); there is no predicate vocabulary and no assertion table.

**The closed relation vocabulary** — the seven relations of `schema.md` §6, each typed by the pair of entity types it connects. `involves`, `concerns`, `attended`, `relates_to`, `became`, `blocks`, `knows`. Adding a relation name is a schema change, which is the honest cost ADR-0014 accepts to stop the graph fragmenting into `works_on`, `working_on`, and `involved_with`.

**Candidate generation** — deterministic and cheap: exact alias hits, fuzzy name match, and embedding nearest-neighbours against the entity projection, narrowing thousands of entities to a handful. Required regardless of model quality, because the entity graph does not fit in a context window.

**The `Embedder` port and its local adapter.** `bge-small-en-v1.5` or equivalent, local always, no cloud option (`runtime.md` §2). Embeddings serve candidate generation, not user-facing search — the quality bar is "narrow thousands of entities to a handful," and sending every entity to a provider for a job a 130 MB local model does well is a privacy cost with no return.

**SQLite-Vector 1.0** (`sqliteai/sqlite-vector`), loadable binary extension, vectors as ordinary `BLOB` columns in ordinary tables — no virtual table (`runtime.md` §4.3). Float32, quantization available and unused. Two things to close here: **re-measure against the standing bar** (the 0.3 ms spike result belongs to a different extension), and **confirm the licence** before it is bundled into a distributed installer.

**Scoring.** Ranks candidates on features Otto controls — name similarity, co-occurrence with other entities resolved in the same Capture, recency of contact, type agreement. **This is where `p(resolution)` comes from**, never the model's self-report, which is a token distribution rather than a probability.

**The `Adjudicator` port**, invoked only when scoring leaves the case genuinely ambiguous. A note and the top three or four candidates in, one choice or none out. It cannot invent an entity id, because the only ids it has seen are the ones it was given. **When adjudication runs, the confidence is still the scorer's margin between the top two candidates** (`triage.md` §1) — an adjudicated pick among near-identical candidates is not made confident by having been adjudicated.

**The resolution bias.** Deliberately toward "none of these" over a wrong match (ADR-0009): a duplicate Person is recoverable by merge, a fact attached to the wrong person quietly corrupts what the user knows. Slice 4 pays the cost of this bias and Slice 7 cleans up what gets through.

**The differ.** No LLM, fully deterministic. Compares resolved-and-extracted values against current entity state and produces Commands. Cardinality comes from the schema: `single` supersedes, `set` unions and never silently drops a member. Dependent fields are handled — `blocker` is cleared by a status change away from `blocked` (`schema.md` §4).

**The Proposal**, carrying its two separate confidences and its provenance, stamped with the aggregate version it was computed against (`add.md` §5.6).

## Not in scope

- **Triage, thresholds, and the application policy.** Slice 4. Commands are produced here; what may happen to them without a human looking is a different question with a different home.
- **Duplicate detection over the entity table.** Slice 7. Candidate generation is built here and Slice 7 points the same machinery at entities instead of at Mentions — which is why it is cheap there.
- **The entity projection as a read surface.** Slice 5. Resolution reads entity state here through a repository port; the dashboard's view of it comes later.
- **Merge and redirects.** Slice 7. The differ produces no merge Command yet.
- **Salience.** Slice 9. It is a derived field the differ must refuse to accept from extraction, which is tested here.

## Build order

1. The knowledge model — five entity types, typed fields per `schema.md`, and the relation vocabulary with its type-pair constraints.
2. `*Repository` ports, read-only from `inference/`'s perspective, with in-memory adapters.
3. `Embedder` port and local adapter; SQLite-Vector integration, re-measurement, and the licence check.
4. Candidate generation: alias, fuzzy, and vector.
5. Scoring, producing `p(resolution)` from the scorer's features.
6. `Adjudicator` port, its adapters, and the ambiguity trigger that decides when to call it.
7. The differ, reading cardinality and floors from the schema as data.

## Verification

Tier 2 (`qa.md` §7.2, §7.3), thorough, property-based where the statement is universal:

**The differ:**

- **Cardinality from the schema**: a `single` field with a new value produces a supersession; a `set` field unions and **never silently drops a member**.
- Per-field floors are read from `schema.md`, not hardcoded in the differ.
- Dependent fields: `blocker` cleared by a status change away from `blocked`.
- No-op diff produces no Command.
- **The model never emits a Command.** Structural, and the reason invented ids and hallucinated field names are impossible. Worth an explicit test of the seam.

**Relations:**

- Each of the seven accepts only its declared from→to type pairs; a `knows` between a Person and a Project is rejected.
- Cardinality: `became` is `single`, the rest are `set`.
- **`knows` is only recorded when a note says so, never inferred from co-occurrence** — an easy and tempting bug that would fill the graph with noise.
- Monitoring rather than assertion: `relates_to`'s share of the graph is a reported metric. If it dominates, the vocabulary is too small.

**Resolution** (Tier 3, measured — `qa.md` §6.1):

- Resolution accuracy: right entity chosen among candidates.
- **Resolution bias direction**, reported as *separate* error classes rather than a blended number. An implementation that improved overall accuracy while shifting errors from "none of these" toward "wrong match" would look better on a blended metric and be worse for the product.
- The two confidences stay separate throughout and are combined only at triage. A Proposal inspected mid-pipeline carrying a single blended number is a failure.
- Two notes mentioning the same new entity: serialisation prevents a race (`qa.md` §6.2). One Sarah, not two.

**Performance** (`qa.md` §8): vector search over 3,000 entities, top-20, re-measured against the ≤ 100 ms bar on the real extension.

## Done when

- A Capture's Mentions resolve to existing entities or to "none of these," and the differ produces Commands against the five entity types and seven relations.
- `p(extraction)` and `p(resolution)` travel separately, and no code path blends them.
- The vector extension is re-measured against the standing bar and its licence is confirmed — `stack.md` §8's row on it closes.
- The eval set reports resolution accuracy and bias direction as separate numbers.
