import Database from "better-sqlite3";
import { CREATE_SCHEMA } from "./schema.js";

/**
 * The one connection both truth tables are reached through.
 *
 * `EventStore` and `CaptureStore` are separate ports because events and
 * Captures are different things (`add.md` §9) — but they are two tables in one
 * database, and the startup sweep anti-joins across both. One connection is
 * what makes that join possible; it is also what keeps the single-writer
 * assumption WAL rests on (`runtime.md` §1), since two handles writing the same
 * file is the concurrency problem that assumption exists to avoid.
 *
 * The driver is `better-sqlite3`, chosen because it can load a binary
 * extension: the vector extension is a `.dylib`/`.so`/`.dll` rather than an npm
 * package (`runtime.md` §4.3), and it lands in Slice 3.
 */
export function openDatabase(filename = ":memory:"): Database.Database {
  const database = new Database(filename);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("recursive_triggers = ON");
  database.exec(CREATE_SCHEMA);
  return database;
}
