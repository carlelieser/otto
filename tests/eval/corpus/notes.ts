import type { EvalCase } from "./case.js";

/**
 * The hand-built eval corpus (`qa.md` §6.2, ADR-0006).
 *
 * **These are the cases the design says are hard, not representative notes.**
 * A corpus of ordinary notes measures the easy path and reports a number that
 * looks good and predicts nothing. Every case below names the category it
 * exercises, and `corpus.test.ts` fails if a category is unrepresented.
 *
 * It starts hand-built and grows from real corrections later — ADR-0006 sets
 * ~50 as the minimum for a regression suite, and because a Correction records
 * the counterfactual, each one is an input/correct-output pair that can be
 * appended here directly.
 *
 * Two conventions, both from `qa.md` §2's rule that an exact-string assertion
 * fails for reasons unrelated to Otto being broken:
 *
 * - A case states what must be *found*, not what must be returned. Fields it
 *   does not mention are not scored.
 * - Notes are written as a person would speak or type them, including the
 *   fragments and missing punctuation that real capture produces. A corpus of
 *   well-formed sentences measures a different model than the one Otto runs.
 */

/** A fixed capture instant, so relative dates in the corpus resolve reproducibly. */
const MONDAY = "2026-08-03T09:00:00.000Z";

/** A second instant late in a quarter, for cases where the quarter boundary matters. */
const LATE_SEPTEMBER = "2026-09-28T17:30:00.000Z";

export const EVAL_CORPUS: readonly EvalCase[] = [
  // ---------------------------------------------------------------- creates
  {
    id: "create-person-and-project",
    covers: "unambiguous-create",
    note: "Had lunch with Priya about the Meridian rollout.",
    capturedAt: MONDAY,
    why: "`triage.md` §3's own example: two entities Otto has never seen, and the case where creating is not a guess.",
    expected: [
      { text: "Priya", entityType: "Person" },
      { text: "Meridian rollout", entityType: "Project" },
    ],
  },
  {
    id: "create-person-with-employer",
    covers: "unambiguous-create",
    note: "Met Tomas Bergqvist, he's a staff engineer at Nordvik.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Tomas Bergqvist",
        entityType: "Person",
        fields: [
          { field: "employer", value: "Nordvik" },
          { field: "role", value: "staff engineer" },
        ],
      },
    ],
  },
  {
    id: "create-task",
    covers: "unambiguous-create",
    note: "Need to send the revised quote to Adaora.",
    capturedAt: MONDAY,
    expected: [
      { text: "send the revised quote", entityType: "Task" },
      { text: "Adaora", entityType: "Person" },
    ],
  },
  {
    id: "create-idea",
    covers: "unambiguous-create",
    note: "Idea: a weekly digest that only shows what changed since last Friday.",
    capturedAt: MONDAY,
    expected: [{ text: "weekly digest", entityType: "Idea" }],
  },
  {
    id: "create-event-with-attendee",
    covers: "unambiguous-create",
    note: "Design review Thursday with Kenji.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Design review",
        entityType: "Event",
        fields: [
          { field: "kind", value: "meeting" },
          { field: "occurred_at", timestamp: "2026-08-06T00:00:00.000Z", precision: "day" },
        ],
      },
      { text: "Kenji", entityType: "Person" },
    ],
  },

  // ------------------------------------------- same name, different person
  {
    id: "different-sarah",
    covers: "same-name-different-person",
    note: "New Sarah started on the design team today, not Sarah from accounts.",
    capturedAt: MONDAY,
    why: "The review-triggering create (`triage.md` §3). Extraction's job is to report both Mentions as the text gives them; deciding they are two people is resolution's.",
    expected: [
      { text: "Sarah", entityType: "Person" },
      { text: "Sarah", entityType: "Person" },
    ],
  },
  {
    id: "same-first-name-different-surname",
    covers: "same-name-different-person",
    note: "Call with James Okonkwo about the audit. Different James to the one at Ferrolane.",
    capturedAt: MONDAY,
    expected: [
      { text: "James Okonkwo", entityType: "Person" },
      { text: "James", entityType: "Person" },
    ],
  },
  {
    id: "namesake-project",
    covers: "same-name-different-person",
    note: "Atlas the internal tool, not Atlas the client engagement.",
    capturedAt: MONDAY,
    expected: [
      { text: "Atlas", entityType: "Project" },
      { text: "Atlas", entityType: "Project" },
    ],
  },

  // --------------------------------------- same new entity in two captures
  {
    id: "concurrent-first",
    covers: "concurrent-mention",
    note: "Kicked off the Selkirk migration this morning.",
    capturedAt: MONDAY,
    why: "Paired with `concurrent-second`: two notes mentioning the same new entity (`qa.md` §6.2). The race it names is `add.md` §4's, and **extraction cannot observe it** — this stage reads nothing but the text, so both notes extract identically whatever order they arrive in. The pair is here because Slice 4 needs exactly this input to test that serialisation prevents a duplicate Selkirk, and a corpus case added later would not have been measured against extraction at all.",
    expected: [{ text: "Selkirk migration", entityType: "Project" }],
  },
  {
    id: "concurrent-second",
    covers: "concurrent-mention",
    note: "Selkirk migration is blocked on the vendor contract.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Selkirk migration",
        entityType: "Project",
        fields: [
          { field: "status", value: "blocked" },
          { field: "blocker", value: "vendor contract" },
        ],
      },
    ],
  },

  // ------------------------------------------------- mis-transcribed names
  {
    id: "mistranscribed-sarah",
    covers: "mis-transcribed-name",
    note: "Coffee with Sara about the Helios rollout.",
    capturedAt: MONDAY,
    why: "`runtime.md` §2 names proper-noun recall as the metric that matters. Extraction must return the name as written — correcting it to a known 'Sarah' is resolution's decision and would destroy the evidence resolution needs.",
    expected: [
      { text: "Sara", entityType: "Person" },
      { text: "Helios rollout", entityType: "Project" },
    ],
  },
  {
    id: "mistranscribed-phonetic",
    covers: "mis-transcribed-name",
    note: "Sync with Wren Adebayo-Clarke, or that's what it sounded like.",
    capturedAt: MONDAY,
    expected: [{ text: "Wren Adebayo-Clarke", entityType: "Person" }],
  },
  {
    id: "mistranscribed-run-together",
    covers: "mis-transcribed-name",
    note: "spoke to marcus at northgate about the renewal",
    capturedAt: MONDAY,
    why: "No capitalisation and no punctuation, which is what dictation produces. The names are still names.",
    expected: [
      { text: "marcus", entityType: "Person", fields: [{ field: "employer", value: "northgate" }] },
    ],
  },

  // ------------------------------------------------------- date precision
  {
    id: "date-exact",
    covers: "date-precision",
    note: "Standup moved to 3 August at 14:30.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Standup",
        entityType: "Event",
        fields: [
          { field: "occurred_at", timestamp: "2026-08-03T14:30:00.000Z", precision: "exact" },
        ],
      },
    ],
  },
  {
    id: "date-day-relative",
    covers: "date-precision",
    note: "Ship the beta next Tuesday.",
    capturedAt: MONDAY,
    why: "The base case for resolution against the Capture timestamp: Monday 3 August plus 'next Tuesday' is 11 August, not tomorrow.",
    expected: [
      {
        text: "Ship the beta",
        entityType: "Task",
        fields: [{ field: "due", timestamp: "2026-08-11T00:00:00.000Z", precision: "day" }],
      },
    ],
  },
  {
    id: "date-day-ordinal",
    covers: "date-precision",
    note: "Invoice is due on the 20th.",
    capturedAt: MONDAY,
    why: "'On the 4th' is `schema.md` §8's own example of what must not blur into a quarter. The month comes from the Capture timestamp.",
    expected: [
      {
        text: "Invoice",
        entityType: "Task",
        fields: [{ field: "due", timestamp: "2026-08-20T00:00:00.000Z", precision: "day" }],
      },
    ],
  },
  {
    id: "date-month",
    covers: "date-precision",
    note: "The Aurora contract renews sometime in November.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Aurora contract",
        entityType: "Project",
        fields: [{ field: "due", timestamp: "2026-11-01T00:00:00.000Z", precision: "month" }],
      },
    ],
  },
  {
    id: "date-quarter",
    covers: "date-precision",
    note: "Hiring for the platform team opens up sometime next quarter.",
    capturedAt: MONDAY,
    why: "`schema.md` §8's other example. Q3 at capture, so 'next quarter' is Q4 — and it must display as Q4, never as 1 October.",
    expected: [
      {
        text: "Hiring for the platform team",
        entityType: "Task",
        fields: [{ field: "due", timestamp: "2026-10-01T00:00:00.000Z", precision: "quarter" }],
      },
    ],
  },
  {
    id: "date-quarter-across-year-boundary",
    covers: "date-precision",
    note: "Budget review lands next quarter.",
    capturedAt: LATE_SEPTEMBER,
    why: "Captured in late Q3, so 'next quarter' is Q4 of the same year — the off-by-one that a naive +3 months from the capture date gets right and a naive quarter increment gets wrong.",
    expected: [
      {
        text: "Budget review",
        entityType: "Event",
        fields: [
          { field: "occurred_at", timestamp: "2026-10-01T00:00:00.000Z", precision: "quarter" },
        ],
      },
    ],
  },
  {
    id: "date-year",
    covers: "date-precision",
    note: "We started the Kestrel work back in 2023.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Kestrel work",
        entityType: "Project",
        fields: [{ field: "started_at", timestamp: "2023-01-01T00:00:00.000Z", precision: "year" }],
      },
    ],
  },
  {
    id: "date-yesterday",
    covers: "date-precision",
    note: "Yesterday's retro went long.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "retro",
        entityType: "Event",
        fields: [{ field: "occurred_at", timestamp: "2026-08-02T00:00:00.000Z", precision: "day" }],
      },
    ],
  },
  {
    id: "date-end-of-month",
    covers: "date-precision",
    note: "Contractor finishes at the end of the month.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Contractor finishes",
        entityType: "Task",
        fields: [{ field: "due", precision: "month" }],
      },
    ],
  },

  // -------------------------------------------------- relative_unresolved
  {
    id: "unresolved-contract-lands",
    covers: "relative-unresolved",
    note: "We'll staff up when the contract lands.",
    capturedAt: MONDAY,
    why: "`schema.md` §8's own example of the honest failure case. It stores no timestamp, keeps the phrase, and is excluded from anything time-ordered.",
    expected: [
      {
        text: "staff up",
        entityType: "Task",
        fields: [{ field: "due", timestamp: null, precision: "relative_unresolved" }],
      },
    ],
  },
  {
    id: "unresolved-after-migration",
    covers: "relative-unresolved",
    note: "Revisit the pricing page after the migration is done.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Revisit the pricing page",
        entityType: "Task",
        fields: [{ field: "due", timestamp: null, precision: "relative_unresolved" }],
      },
    ],
  },
  {
    id: "unresolved-when-funding-clears",
    covers: "relative-unresolved",
    note: "Ravi joins the Perigee project when funding clears.",
    capturedAt: MONDAY,
    expected: [
      { text: "Ravi", entityType: "Person" },
      { text: "Perigee project", entityType: "Project" },
    ],
  },

  // ---------------------------------------------------- the notes valve
  {
    id: "notes-allergy",
    covers: "notes-pressure-valve",
    note: "Sarah is allergic to shellfish.",
    capturedAt: MONDAY,
    why: "`schema.md` §7's own example. A schema that cannot express this should still not throw the sentence away.",
    expected: [{ text: "Sarah", entityType: "Person", fields: [{ field: "notes" }] }],
  },
  {
    id: "notes-preference",
    covers: "notes-pressure-valve",
    note: "Dmitri only takes meetings before 11am.",
    capturedAt: MONDAY,
    expected: [{ text: "Dmitri", entityType: "Person", fields: [{ field: "notes" }] }],
  },
  {
    id: "notes-project-detail",
    covers: "notes-pressure-valve",
    note: "The Cascade rebuild uses a vendor SDK we can't patch ourselves.",
    capturedAt: MONDAY,
    expected: [{ text: "Cascade rebuild", entityType: "Project", fields: [{ field: "notes" }] }],
  },
  {
    id: "notes-family-detail",
    covers: "notes-pressure-valve",
    note: "Yusuf's daughter is starting at the same school as ours.",
    capturedAt: MONDAY,
    expected: [{ text: "Yusuf", entityType: "Person", fields: [{ field: "notes" }] }],
  },

  // ------------------------------------------------- enums outside the set
  {
    id: "enum-relationship-mentor",
    covers: "enum-outside-set",
    note: "Ingrid has been my mentor since the Talara days.",
    capturedAt: MONDAY,
    why: "`schema.md` §7: outside the closed set, so `other` plus a `notes` entry. A run of these is the signal the enum needs a new member, and it arrives as data rather than as a bug report.",
    expected: [
      {
        text: "Ingrid",
        entityType: "Person",
        fields: [{ field: "relationship", value: "other" }, { field: "notes" }],
      },
    ],
  },
  {
    id: "enum-relationship-landlord",
    covers: "enum-outside-set",
    note: "Bram is my landlord, sorting the boiler on Friday.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Bram",
        entityType: "Person",
        fields: [{ field: "relationship", value: "other" }, { field: "notes" }],
      },
    ],
  },
  {
    id: "enum-project-status-outside-set",
    covers: "enum-outside-set",
    note: "The Tessellate project is in limbo pending legal.",
    capturedAt: MONDAY,
    why: "'In limbo' is not `active`, `blocked`, `paused`, `done`, or `abandoned` — though `blocked` is a defensible reading, which is why only the notes entry is scored.",
    expected: [{ text: "Tessellate project", entityType: "Project", fields: [{ field: "notes" }] }],
  },
  {
    id: "enum-event-kind-outside-set",
    covers: "enum-outside-set",
    note: "Offsite in Porto next month, three days of workshops.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Offsite",
        entityType: "Event",
        fields: [{ field: "location", value: "Porto" }],
      },
    ],
  },

  // ------------------------------------------------------ degenerate notes
  {
    id: "degenerate-empty",
    covers: "degenerate-note",
    note: "",
    capturedAt: MONDAY,
    why: "`qa.md` §6.2 asks for empty, single-word, and very long notes. An empty note is a real thing a hotkey produces.",
    expected: [],
  },
  {
    id: "degenerate-whitespace",
    covers: "degenerate-note",
    note: "   ",
    capturedAt: MONDAY,
    expected: [],
  },
  {
    id: "degenerate-single-word-name",
    covers: "degenerate-note",
    note: "Anneke",
    capturedAt: MONDAY,
    why: "A single word that is a name is a Person with nothing claimed about them, not a parse failure.",
    expected: [{ text: "Anneke", entityType: "Person" }],
  },
  {
    id: "degenerate-single-word-not-a-name",
    covers: "degenerate-note",
    note: "hmm",
    capturedAt: MONDAY,
    expected: [],
  },
  {
    id: "degenerate-very-long",
    covers: "degenerate-note",
    note: [
      "Long one, bear with me.",
      "Spoke to Halvard about the Ridgeline programme for about an hour.",
      "The short version is that the vendor integration is late again and that pushes the pilot into next quarter,",
      "which he is not happy about because he committed to the board that it would land this one.",
      "He wants to bring in Noor to take over the integration workstream specifically,",
      "leaving Halvard on the commercial side, which honestly should have been the split from the start.",
      "There is also a question about whether we keep paying for the sandbox environment while this drags on;",
      "he is going to check the contract and come back to me.",
      "Separately he mentioned that Ridgeline has a hard dependency on the Selkirk migration finishing first,",
      "which nobody had written down anywhere as far as I can tell.",
      "Action for me is to write that dependency up and send it to both of them before Friday.",
    ].join(" "),
    capturedAt: MONDAY,
    why: "A real note is not a sentence. This one carries several entities, a status change, a dependency, and an action, and it is where whole-note extraction at 8B is most likely to degrade — which is exactly what `runtime.md` §2's decomposition fallback exists for.",
    expected: [
      { text: "Halvard", entityType: "Person" },
      { text: "Ridgeline programme", entityType: "Project" },
      { text: "Noor", entityType: "Person" },
      { text: "Selkirk migration", entityType: "Project" },
    ],
  },

  // ------------------------------------------- nothing to extract
  {
    id: "nothing-weather",
    covers: "no-extractable-entity",
    note: "Rained all afternoon.",
    capturedAt: MONDAY,
    why: "A valid outcome that must not produce a spurious Proposal (`qa.md` §6.2). This is a precision test, and the failure it catches is a model that invents an Event to have something to say.",
    expected: [],
  },
  {
    id: "nothing-mood",
    covers: "no-extractable-entity",
    note: "Feeling better about all of it today.",
    capturedAt: MONDAY,
    expected: [],
  },
  {
    id: "nothing-fragment",
    covers: "no-extractable-entity",
    note: "...and then the other thing, obviously",
    capturedAt: MONDAY,
    expected: [],
  },
  {
    id: "nothing-shopping",
    covers: "no-extractable-entity",
    note: "milk, bread, washing up liquid",
    capturedAt: MONDAY,
    why: "Task-shaped enough to tempt a model into three Tasks. It is a shopping list, and Otto is not a task manager (PRD §6).",
    expected: [],
  },

  // ------------------------------------------------------- ordinary notes
  {
    id: "ordinary-status-change",
    covers: "ordinary",
    note: "Beacon redesign is done, shipped it this morning.",
    capturedAt: MONDAY,
    why: "The corpus is weighted toward hard cases, but a few ordinary ones keep the metrics honest — a model that scored well only on the hard cases would be overfitted to them.",
    expected: [
      {
        text: "Beacon redesign",
        entityType: "Project",
        fields: [{ field: "status", value: "done" }],
      },
    ],
  },
  {
    id: "ordinary-relationship",
    covers: "ordinary",
    note: "Farida is a colleague on the data team, based in Lisbon.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Farida",
        entityType: "Person",
        fields: [
          { field: "relationship", value: "colleague" },
          { field: "location", value: "Lisbon" },
        ],
      },
    ],
  },
  {
    id: "ordinary-blocked-project",
    covers: "ordinary",
    note: "Quarry pipeline is blocked, waiting on security review.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Quarry pipeline",
        entityType: "Project",
        fields: [
          { field: "status", value: "blocked" },
          { field: "blocker", value: "security review" },
        ],
      },
    ],
  },
  {
    id: "ordinary-task-done",
    covers: "ordinary",
    note: "Finally sent the Halvorsen proposal.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Halvorsen proposal",
        entityType: "Task",
        fields: [{ field: "status", value: "done" }],
      },
    ],
  },
  {
    id: "ordinary-contact-detail",
    covers: "ordinary",
    note: "Oyelaran's new address is t.oyelaran@brightpath.example.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Oyelaran",
        entityType: "Person",
        fields: [{ field: "contact", value: "t.oyelaran@brightpath.example" }],
      },
    ],
  },
  {
    id: "ordinary-employer-change",
    covers: "ordinary",
    note: "Mei has moved from Acme to Globex.",
    capturedAt: MONDAY,
    why: "`employer` is single-valued and supersedes; the old value lives in the log, not in a set (`schema.md` §3). Extraction claims the new one.",
    expected: [
      {
        text: "Mei",
        entityType: "Person",
        fields: [{ field: "employer", value: "Globex" }],
      },
    ],
  },
  {
    id: "ordinary-idea-promoted",
    covers: "ordinary",
    note: "That digest idea is becoming a real project now, calling it Lantern.",
    capturedAt: MONDAY,
    expected: [
      { text: "digest idea", entityType: "Idea" },
      { text: "Lantern", entityType: "Project" },
    ],
  },
  {
    id: "ordinary-meeting-outcome",
    covers: "ordinary",
    note: "Board call went fine, they approved the extra headcount.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Board call",
        entityType: "Event",
        fields: [{ field: "kind", value: "call" }],
      },
    ],
  },
  {
    id: "ordinary-two-people-know-each-other",
    covers: "ordinary",
    note: "Turns out Priya and Kenji went to university together.",
    capturedAt: MONDAY,
    why: "`knows` is recorded only when a note says so, never inferred from co-occurrence (`qa.md` §7.3). This note says so; most notes naming two people do not.",
    expected: [
      { text: "Priya", entityType: "Person" },
      { text: "Kenji", entityType: "Person" },
    ],
  },
  {
    id: "ordinary-next-action",
    covers: "ordinary",
    note: "Next thing on Meridian is to get the data model signed off.",
    capturedAt: MONDAY,
    expected: [
      {
        text: "Meridian",
        entityType: "Project",
        fields: [{ field: "next_action", value: "get the data model signed off" }],
      },
    ],
  },
];
