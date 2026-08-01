# SQLite spike — results

> Answers the gate in [`runtime.md` §4](../../docs/runtime.md), ADR-0013, and ADD §12:
> **can SQLite carry an append-only log plus rebuildable projections at single-user scale?**
>
> **Verdict: yes, with room to spare.** All seven bars pass, the closest by a
> factor of 20. Vector search — named as the likeliest failure — passes by 300×.

Run on Apple M1 Max, macOS 15 (darwin/arm64), Node v24.3.0, SQLite 3.49.2,
`better-sqlite3` 11.10, `sqlite-vec` 0.1.9, WAL + `synchronous=NORMAL`.

## Results at the specified corpus

10,000 Captures · 41,240 events · 3,000 entities · 9,970 relations · 24,966 Proposals, spanning 5.00 years.

| Measurement | Result | Pass bar | Fail bar | Verdict | Margin |
|---|---|---|---|---|---|
| Full projection rebuild from event zero | **215 ms** | ≤ 60 s | > 5 min | PASS | 280× |
| Incremental catch-up, 100 events | **11.6 ms** (p95) | ≤ 500 ms | > 2 s | PASS | 43× |
| Entity view — row + relations + provenance | **0.1 ms** (p95) | ≤ 50 ms | > 200 ms | PASS | 500× |
| Vector search over 3,000 entities, top-20 | **0.3 ms** (p95) | ≤ 100 ms | > 500 ms | PASS | 330× |
| Full-text search over 10,000 Captures | **1.7 ms** (p95) | ≤ 100 ms | > 500 ms | PASS | 59× |
| Event append with WAL, sidecar writing | **0.1 ms** (p95) | ≤ 10 ms | > 50 ms | PASS | 100× |
| Database size on disk | **47.8 MB** | ≤ 2 GB | > 10 GB | PASS | 42× |

Nothing landed in the warn band between pass and fail. Latency figures are p95
over 200–500 iterations, not means — the bars read as user-facing promises, and
a median hides the stall that a user would actually notice.

Stable across seeds: rebuild 208–222 ms over seeds 1, 7, 42, 99, 2024.

## The three questions the spec asked us to answer

**Vector search is not the failure it was expected to be.** `sqlite-vec` returns
top-20 over 3,000 × 384d vectors in 0.3 ms p95, against a 100 ms bar. It stays
under the bar to 75,000 entities (21 ms at ×25). The contingency in `runtime.md`
§4 and ADD §12 — a separate on-disk index rebuilt from the log — is not needed,
and the reasoning that made it cheap (embeddings are already derived state,
ADR-0005) can stay on the shelf rather than being built.

One caveat worth carrying: `sqlite-vec` is pre-1.0 (0.1.9, alpha-tagged on npm)
and does brute-force scan, not ANN. Brute force is why the numbers are honest and
linear — but it means cost grows with entity count, not log(n). At Otto's scale
that is entirely fine, and the linearity is visible in the scaling table below.

**No bar failed, so the snapshot fallback is not load-bearing.** It was measured
anyway, since `runtime.md` §4 says a full-rebuild failure is only fatal if
snapshot-resumed rebuilds also fail: replaying the last 10% of the log takes
24 ms against a 215 ms full rebuild. Snapshotting works and scales as expected —
it is simply not needed yet.

**Snapshot cadence — the open tuning parameter in ADR-0011 — can be answered
now, and the answer is "don't."** Full rebuild costs 215 ms at the specified
corpus and 15 s at 25× it. Snapshotting exists to keep rebuild proportional to
recent activity, and rebuild is not a cost worth managing until the log is
~30–50× larger than five years of heavy use. The recommendation is to keep the
snapshot *mechanism* (it is already built, and ADR-0011 is right that it is the
correct shape) but set the cadence to "never" for MVP and revisit if the log
passes ~1M events.

## Where it actually breaks

The bars are defined at ×1. The corpus generator scales, so the interesting
question is where the design stops holding rather than by how much it passes.

| Scale | Events | Captures | Entities | Rebuild | Vector | FTS | Size | Overall |
|---|---|---|---|---|---|---|---|---|
| ×1 | 41,240 | 10,000 | 3,000 | 0.21 s | 0.3 ms | 1.7 ms | 48 MB | PASS |
| ×5 | 206,443 | 50,000 | 15,000 | 1.52 s | 1.5 ms | 5.8 ms | 237 MB | PASS |
| ×10 | 413,141 | 100,000 | 30,000 | 3.90 s | 8.5 ms | 10.7 ms | 474 MB | PASS |
| ×25 | 1,032,365 | 250,000 | 75,000 | 15.06 s | 21.2 ms | 27.3 ms | 1.18 GB | PASS |

Every bar still passes at ×25 — one million events, a quarter-million Captures,
about 125 years of use at the assumed rate. Rebuild is linear at ~68,000
events/sec and would reach the 60 s bar somewhere near 4M events. Disk is the
first bar that would realistically bind, at roughly 2 GB / 45× the spec.

**The storage assumption is not the risk it was flagged as.** The measurements
say the projection model is comfortable, not marginal — which is the specific
thing ADD §12 wanted to know before schema work began.

## What this does and does not prove

Honest about the edges, because a spike that overclaims is worse than no spike.

- **The projection model is realistic; the projection *logic* is not the real
  one.** Events fold into typed columns with per-field provenance pointers,
  set-valued fields union, single-valued fields supersede, redirects resolve
  transitively. But the real projector will do more per event — salience,
  backlinks, counts, embeddings-on-update. If several bars later degrade
  together, `runtime.md` §4 already names the conclusion: the projection model is
  doing too much work per event, not that SQLite is wrong.
- **Embeddings are synthetic.** The spike measures the index, not embedding
  quality — vectors are normalised gaussians with a mild per-type cluster.
  Retrieval *quality* is an eval-set question (`qa.md` §6), not a spike question.
- **Single-process.** The sidecar's real concurrency — the UI reading
  projections while the projection worker writes — is untested here. WAL is
  designed for exactly that shape, and ADD §4 serialises the pipeline, so the
  risk is low; but "one reader, one writer, WAL" remains an assumption rather
  than a measurement.
- **Warm cache, SSD, M1 Max.** A five-year-old laptop with a spinning disk would
  be slower. The margins are large enough (42–500×) that this does not change the
  verdict, but the numbers are a ceiling rather than a floor.
- **Capture-under-load is not measured here.** `qa.md` §8 requires that capture
  round-trip stays responsive while the pipeline is saturated. That is a
  process-model test, not a storage one, and it needs the real sidecar.

## Reproducing

```bash
cd spikes/sqlite
npm install
npm run spike                 # the seven bars at the specified corpus
npm run verify                # proves the measurements time real work
node src/run.js --scale 10    # find where it breaks
node src/run.js --json out.json --keep
```

`npm run verify` is the check worth running first: a rebuild that silently
no-ops is very fast, so it asserts that projections are populated, that
supersession keeps the last event's value, that a second rebuild is byte-identical
to the first, that partial-plus-catch-up equals a full rebuild, and that field
provenance resolves through to model and confidence. It caught two corpus bugs
during development that would have made the numbers meaningless.
