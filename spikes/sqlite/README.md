# SQLite spike

Answers the gate in [`runtime.md` §4](../../docs/runtime.md): can SQLite carry an
append-only log plus rebuildable projections at single-user scale? It runs before
schema work because its outcome could change the storage design (ADR-0013).

**[FINDINGS.md](./FINDINGS.md) has the results.** Short version: all seven bars
pass, the closest by 20×, and vector search — the expected failure — passes by 300×.

```bash
npm install
npm run spike     # the seven measurements against the specified corpus
npm run verify    # proves the measurements time real work
```

| File | What it is |
|---|---|
| `src/schema.js` | SQL schema — two truth tables, derived projections in a `d_` namespace |
| `src/corpus.js` | Synthetic corpus shapes, deterministic PRNG, pseudo-embeddings |
| `src/generate.js` | Writes Captures and the event log |
| `src/project.js` | The projection worker: folds the log into projections |
| `src/measure.js` | The seven measurements and their bars |
| `src/run.js` | Runner and report |
| `src/verify.js` | Correctness checks — run this before believing any timing |

Options: `--seed N`, `--scale N` (corpus multiplier; bars are defined at ×1),
`--json out.json`, `--keep` (leave the database on disk), `--db path`.
