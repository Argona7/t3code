import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Upstream owns the numbered migration sequence. Fork storage upgrades independently.
export const initializeThreadFolderSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS argona_thread_folder_revision (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL,
    revision INTEGER NOT NULL
  )`;
  yield* sql`INSERT OR IGNORE INTO argona_thread_folder_revision (singleton, schema_version, revision)
    VALUES (1, 1, 0)`;
  const rows = yield* sql<{
    schema_version: number;
  }>`SELECT schema_version FROM argona_thread_folder_revision WHERE singleton = 1`;
  if (rows[0]?.schema_version !== 1) {
    return yield* Effect.die(
      new Error("This build cannot open this version of the thread folder catalog."),
    );
  }
  yield* sql`CREATE TABLE IF NOT EXISTS argona_thread_folders (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    color INTEGER NOT NULL CHECK (color BETWEEN 0 AND 7)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS argona_thread_folder_assignments (
    thread_id TEXT PRIMARY KEY NOT NULL,
    folder_id TEXT NOT NULL REFERENCES argona_thread_folders(id) ON DELETE CASCADE
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS argona_thread_folder_members ON argona_thread_folder_assignments(folder_id, thread_id)`;
});
