import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/infrastructure/persistence/database.js";
import { SqliteEventStore } from "../../src/infrastructure/persistence/sqlite-event-store.js";
import { CREATE_SCHEMA } from "../../src/infrastructure/persistence/schema.js";
import { FROM_START } from "../../src/ports/event-store.js";
import { aCaptureIngested } from "../support/builders.js";

/**
 * What is true of SQLite specifically. The port's own behaviour — append, read
 * forward, idempotency — lives in `event-store-contract.test.ts` and
 * `append-idempotency.property.test.ts`.
 */
describe("SQLite refuses mutation at the database level", () => {
  // qa.md §4.1 asks for this independently of the repository-level assertion,
  // because a test that the application declines to do something is weaker
  // than a database that will not permit it.
  let database: Database.Database;

  afterEach(() => database?.close());

  const SEED_ROWS = [
    `INSERT INTO events (
       event_id, type, version, aggregate_type, aggregate_id, aggregate_version,
       payload, proposal_id, capture_id, provider, model_version,
       confidence, is_human_confirmed, recorded_at
     ) VALUES ('evt-1', 'CaptureIngested', 1, 'Capture', 'cap-1', 0,
       '{}', 'prop-1', 'cap-1', 'local', 'qwen2.5-7b', 0.9, 0, '2026-08-01T09:00:00Z')`,
    `INSERT INTO captures (capture_id, source, raw_text, source_timestamp, content_hash, ingested_at)
     VALUES ('cap-1', 'typed', 'hello', '2026-08-01T09:00:00Z',
       '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
       '2026-08-01T09:00:00Z')`,
  ];

  function seededDatabase(): Database.Database {
    database = new Database(":memory:");
    database.exec(CREATE_SCHEMA);
    for (const row of SEED_ROWS) database.prepare(row).run();
    return database;
  }

  // A column each table actually has, so the UPDATE reaches the trigger rather
  // than failing at parse time.
  it.each([
    ["events", "type"],
    ["captures", "raw_text"],
  ])("rejects UPDATE on %s", (table, column) => {
    const seeded = seededDatabase();
    expect(() => seeded.prepare(`UPDATE ${table} SET ${column} = 'x'`).run()).toThrow(
      /append-only/,
    );
  });

  it.each(["events", "captures"])("rejects DELETE on %s", (table) => {
    const seeded = seededDatabase();
    expect(() => seeded.prepare(`DELETE FROM ${table}`).run()).toThrow(/append-only/);
  });

  it("rejects an in-place payload edit", () => {
    // qa.md §4.4: an attempted in-place payload edit fails at the storage layer.
    const seeded = seededDatabase();
    expect(() =>
      seeded
        .prepare(`UPDATE events SET payload = '{"tampered":true}' WHERE event_id = 'evt-1'`)
        .run(),
    ).toThrow(/append-only/);
  });

  it("leaves the row untouched after a refused UPDATE", () => {
    const seeded = seededDatabase();
    expect(() => seeded.prepare(`UPDATE events SET type = 'Tampered'`).run()).toThrow();
    const row = seeded.prepare(`SELECT type FROM events WHERE event_id = 'evt-1'`).get() as {
      type: string;
    };
    expect(row.type).toBe("CaptureIngested");
  });
});

describe("the SQLite adapter's storage configuration", () => {
  // These need a real file: an in-memory database reports `journal_mode =
  // memory` and cannot enter WAL at all, so asserting WAL against `:memory:`
  // can only ever pass vacuously.
  let databaseFile: string;

  beforeEach(() => {
    databaseFile = join(mkdtempSync(join(tmpdir(), "otto-wal-")), "otto.db");
  });

  afterEach(() => rmSync(dirname(databaseFile), { recursive: true, force: true }));

  it("runs in WAL mode", () => {
    // stack.md §3: concurrent readers with a single writer is the case WAL is
    // built for, and it is what the sidecar/host split needs.
    const database = openDatabase(databaseFile);
    const store = new SqliteEventStore(database);
    const reader = new Database(databaseFile, { readonly: true });

    const mode = (reader.pragma("journal_mode") as { journal_mode: string }[])[0]!.journal_mode;

    expect(mode).toBe("wal");
    reader.close();
    database.close();
  });

  it("lets a second connection read while the store holds the file open", async () => {
    // The sidecar writes and the host reads on behalf of the WebView
    // (stack.md §3). WAL is what makes that concurrent pair work.
    const database = openDatabase(databaseFile);
    const store = new SqliteEventStore(database);
    await store.append([aCaptureIngested()]);

    const reader = new Database(databaseFile, { readonly: true });
    const { count } = reader.prepare(`SELECT COUNT(*) AS count FROM events`).get() as {
      count: number;
    };

    expect(count).toBe(1);
    reader.close();
    database.close();
  });

  it("persists a log across connections to the same file", async () => {
    const firstConnection = openDatabase(databaseFile);
    const first = new SqliteEventStore(firstConnection);
    await first.append([aCaptureIngested()]);
    firstConnection.close();

    const secondConnection = openDatabase(databaseFile);
    const reopened = new SqliteEventStore(secondConnection);
    expect(await reopened.readForward(FROM_START)).toHaveLength(1);
    secondConnection.close();
  });

  it("can load a binary extension, which the vector extension needs in Slice 3", () => {
    // runtime.md §4.3 constrains the driver choice even though the vector
    // extension does not land until Slice 3.
    const database = new Database(":memory:");
    expect(typeof database.loadExtension).toBe("function");
    database.close();
  });
});
