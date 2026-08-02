# The schema tables are code, and `schema.md` is the authority a test enforces

---
Status: accepted
---

`schema.md` §2–§5's field tables are transcribed into `src/domain/schema/entity-schema.ts` as data, and **a test parses `schema.md` and fails the build when the two disagree.**

`add.md` §5.2 requires the extractor's output schema to be *generated* from `schema.md` rather than hand-written beside it, because that is what makes "the model cannot invent a field name" structural rather than aspirational. Generation needs a machine-readable source, and a Markdown table is not one — so the tables exist twice, and the question this settles is what keeps the copies honest.

**The document is the authority, and the code is the copy.** `schema.md`'s own first line says "where they disagree, this document is wrong" of the SQL; the same ordering holds here, and it is now enforced rather than stated. The test reads the Markdown tables, compares field names, types, cardinalities, and extractability against the code, and fails on any difference in either direction.

Parsing a design document in a test is unusual and was chosen over three alternatives:

- **Generate the TypeScript from the Markdown at build time.** Rejected: it makes a design document a build input, so a prose edit breaks a compile, and the generated file is then either committed and stale or absent and unreadable. The test gives the same guarantee without making the document load-bearing at build time.
- **Move the tables into a data file and generate the Markdown from it.** Rejected for MVP: it inverts the authority, and `schema.md` is a document people read and argue about — §7 and §9's prose is the part that makes the tables mean anything, and it does not survive being generated.
- **Trust the transcription.** Rejected. Everything downstream generates from these tables, so a field the code is missing is a field the model can never propose, and nothing else in the system would notice. It fails silently and looks like a model that never learned to extract `role`.

## Consequences

- **`schema.md`'s table format is now a contract.** Reformatting the field tables can break the build. The parser is deliberately narrow — it reads only the sections between §2 and §6, so the Relation table and the prose are free to change shape.
- **Adding a field is two edits and no ceremony**: the table and the code, in either order, with the test naming the one that is missing.
- **The four properties travel together.** Cardinality and disposition floor are declared here alongside type and extractability even though the differ (Slice 4) and triage (Slice 5) are what read them — `schema.md` §1 lists them as one row's worth of information, and splitting them across slices would put the same field in three places.
- **`salience` and `last_contact_at` are named in a test**, not merely absent from the output schema. `schema.md` §1 requires a derived field the extractor emits to be dropped *and the drop logged as a schema violation*, so the schema has to know they exist in order to reject them deliberately.
