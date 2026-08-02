# A brief is a record, not a projection

---
Status: accepted
---

ADR-0015 established that salience is a projection: derived from the log, writing nothing, replaceable by changing coefficients and recomputing. Slice 10 builds that, and in building it hits a question ADR-0015 does not answer — a brief is produced by a projection, so is a brief itself a projection?

**It is not.** `briefs`, `brief_entities`, and `brief_entity_opens` carry no `projection_` prefix, are absent from `PROJECTION_TABLES`, and survive `reset`.

The reason is that the two are derived from different things. Salience is derived from the log and nothing else, so recomputing it is a rebuild. A brief is derived from the log *and the coefficients in force on the day it was written*, and the second half is not in the log. Recomputing last month's brief under v1's coefficients does not reproduce it — it produces a different brief that is equally true and answers a different question. ADR-0015 anticipates exactly this by promising v0 will be replaced, which guarantees the coefficients will change and therefore guarantees regeneration is lossy.

So `salience.md` §4's "a brief is not regenerated once written" is a storage rule rather than a preference about wasted work. `brief_id` is derived from the kind and the date covered, which makes one-brief-per-day a primary key; the insert is `ON CONFLICT DO NOTHING`; and `BriefWriting` checks for an existing brief before generating, so a repeated run costs no model call. A caller learns which happened from `wasStored` rather than by comparing prose.

**The generator's constraint is checked rather than structural, and that is a real difference from ADR-0007's other boundaries.** `Adjudicator` cannot name an entity outside its candidate list because it returns an index. Prose has no such shape: a model can always write a name nobody supplied. `compose-brief.ts` therefore checks the generated prose against the selected names after the fact and falls back to rendering the selection plainly when it fails.

The check reads runs of adjacent capitalised words and matches each run whole, while permitting single words of any selected name. That asymmetry is deliberate in both directions: permitting single words lets "Sarah" stand for "Sarah Chen" on second mention, because a check that fires on ordinary prose is a check that gets turned off; matching multi-word runs whole stops "Chen Project" passing on the strength of "Sarah Chen" and "Acme Project" having been selected separately — an entity nobody surfaced, assembled from parts of two who were.

**The inputs come from the log, in `read-salient-entities.ts`.** `lastMentionedAt`, `createdAt`, and the per-entity change counts are properties of the *history* rather than of the folded state, which reduces them away by design. Deriving them in the same pass that folds the log is what keeps the ADR-0015 claim honest end to end: there is no stored score, no decay job, and every input to a ranking is recomputable from events alone.

**The instrumentation decides credit itself rather than trusting the caller.** `BriefReads.recordEntityOpened` takes the brief the user was reading as a *claim* and verifies the entity was actually in that brief's selection before crediting it. A dashboard that passed the open brief's id for every entity reached from that screen would inflate precision, which is the one number the v0→v1 measurement exists to produce honestly.

## Considered Options

- **Make briefs a `projection_` table rebuilt from the log** — rejected: the coefficients are not in the log, so a rebuild silently rewrites history under new rules. This is the failure the ADR exists to prevent.
- **Store the coefficients alongside each brief and regenerate faithfully** — rejected: it makes regeneration reproducible but pointless, since the output is byte-identical to what is already stored, at the cost of a model call and a versioned coefficient table.
- **Enforce no-new-entities structurally by having the generator emit ids** — rejected: it constrains prose into a template, which forfeits the pattern-noticing `salience.md` §4 leaves deliberately open.
- **Let the caller assert which brief surfaced an entity** — rejected above; it corrupts the only measurement that replaces v0.

## Consequences

- Briefs accumulate and are never garbage-collected in MVP. At one or two per day this is a few thousand rows a decade, so no retention policy is worth building yet.
- A bad brief is permanent. This is the intended cost: ADR-0015 accepts "a few weeks of mediocre briefs", and a brief the user can see was wrong is more useful to the v1 measurement than one quietly rewritten.
- The prose fallback means a brief always exists even when generation misbehaves, so the selection is never lost to a model failure.
- `brief_entity_opens` is behavioural data about the user, as ADR-0015 notes. It stays local (PRD §4.6) and is derived, so it can be dropped without losing knowledge.
