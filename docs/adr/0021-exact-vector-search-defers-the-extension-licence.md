# Exact vector search in process; the extension's licence defers the bundling decision

---
Status: accepted
---

`runtime.md` §4.3 left two things open about `sqliteai/sqlite-vector` 1.0: the 0.3 ms vector-search result belonged to a different extension and wanted re-measuring, and **the licence was unconfirmed** — GitHub reported no recognised SPDX identifier — and wanted checking "before the extension is bundled into a distributed installer."

The licence has now been checked, and it is not a plain permissive grant.

**`sqliteai/sqlite-vector` is dual-licensed.** Use is free for software incorporated into a project under an OSI-approved open-source licence. Everything else falls under the Elastic License 2.0, which permits non-production use, and production or managed-service deployment requires commercial terms from SQLite Cloud, Inc.

That is a real constraint on Otto rather than a formality. Otto is a distributed desktop application, and the extension would ship as a native binary in the installer per platform (`runtime.md` §4.3). Whether that is permitted turns on a licensing question about Otto itself that this repository has not answered: if Otto ships under an OSI-approved licence the grant covers it, and if it does not, bundling requires a commercial agreement.

## Decision

**Vector search is exact and runs in process, over `BLOB` columns in ordinary tables. The extension is not a dependency.**

The storage spike is what makes this the cheap option rather than a compromise. `runtime.md` §4 predicted vector search as the likeliest failure of the whole storage assumption and it was not — top-20 over 3,000 × 384d in 0.3 ms against a 100 ms bar, still under it at 75,000 entities — and the conclusion it recorded is about SQLite rather than about any one extension: *exact search over this corpus is far below the bar, so the design does not depend on approximate indexing.*

A linear scan over 3,000 vectors is arithmetic. It needs no extension, no per-platform binary in the installer, and no licence.

## Consequences

- **The licence question is deferred rather than answered**, and it is deferred from a position where nothing is blocked on it. `runtime.md` §4.3's row in `stack.md` §8 closes as "not needed at MVP volume" rather than as "confirmed clear."
- **The re-measurement has been taken**, against the implementation that actually ships: **13.8 ms p95** for top-20 over 3,000 × 384d, against the unchanged 100 ms bar (`tests/baselines/vector-search.json`, M-series/arm64).

  That is 46× slower than the 0.3 ms `runtime.md` §4 recorded, and the margin over the bar drops from 330× to about 7×. **The comparison is not like-for-like and the drop is expected**: this reads all 3,000 rows out of SQLite and scores them in process, where the spike's number came from an extension doing the scan inside the database. Row I/O dominates, not the arithmetic.

  7× is still comfortable, and it is measured rather than assumed — which is the state §4.3 asked for. But it is the tightest margin in the standing suite, so this is the row that moves first. The trigger to revisit stays entity count rather than this number in isolation, since the scan is linear in it.
- **The packaging cost §4.3 anticipated does not arrive.** The extension was to join `whisper.cpp` and the embedding model as a native artefact the installer ships per target; it does not, which makes Slice 11's packaging one artefact simpler.
- **Adopting the extension later stays cheap**, for the reason ADR-0005 already gives: embeddings are derived state, so swapping how they are indexed is a projection rebuild rather than a migration. The trigger is entity count growing by an order of magnitude past what the spike measured — at which point the licensing question has to be answered rather than deferred again.
- **Quantization stays unavailable**, which it effectively was anyway. `runtime.md` §4.3 records Float32 as the choice and quantization as available-and-unused, since 3,000 × 384d is small enough that the memory saving buys nothing and quantization trades recall for a resource Otto is not short of.
- The scan is `O(entities)` per query where the extension's would be too, at this size. If it ever stops being, that is the same signal as the paragraph above and has the same two answers: the extension under a resolved licence, or a separate index rebuilt from the log like any other projection.
