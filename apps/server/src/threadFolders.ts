import { initializeThreadFolderSchema } from "./persistence/threadFolderSchema.ts";

import {
  ThreadFolderError,
  ThreadFolderName,
  type ThreadFolder,
  type ThreadFolderMove,
  type ThreadFolderSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export interface FolderChoice {
  readonly folderId?: string | null;
  readonly parentThreadId?: ThreadId;
  readonly allowMissing?: boolean;
}

const storageError = () =>
  new ThreadFolderError({ code: "storage", message: "Could not access thread folders." });

const missing = (folderId: string) =>
  new ThreadFolderError({
    code: "not-found",
    message: `Thread folder ${folderId} does not exist.`,
  });

const decodeFolderName = Schema.decodeEffect(ThreadFolderName);
const normalizeName = (name: string) =>
  decodeFolderName(name.trim()).pipe(
    Effect.mapError(
      () =>
        new ThreadFolderError({
          code: "invalid-name",
          message: "Use a folder name between 1 and 128 characters.",
        }),
    ),
  );

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(initializeThreadFolderSchema).pipe(Effect.orDie);
  const changes = yield* Reactivity.make;
  const keys = ["thread-folders"];
  const changed = sql`UPDATE argona_thread_folder_revision SET revision = revision + 1`.pipe(
    Effect.andThen(sql.afterCommit(changes.invalidate(keys))),
  );

  const list = Effect.fn("ThreadFolders.list")(function* () {
    return yield* sql<ThreadFolder>`SELECT id, name, color FROM argona_thread_folders ORDER BY rowid`;
  }, Effect.mapError(storageError));

  const snapshot = Effect.fn("ThreadFolders.snapshot")(
    function* () {
      const revisions = yield* sql<{
        revision: number;
      }>`SELECT revision FROM argona_thread_folder_revision`;
      const folders = yield* list();
      const assignments = yield* sql<{ thread_id: string; folder_id: string }>`
      SELECT a.thread_id, a.folder_id FROM argona_thread_folder_assignments a
      JOIN orchestration_v2_projection_threads t ON t.thread_id = a.thread_id WHERE t.deleted_at IS NULL`;
      return {
        revision: revisions[0]!.revision,
        folders,
        assignments: Object.fromEntries(assignments.map((row) => [row.thread_id, row.folder_id])),
      } satisfies ThreadFolderSnapshot;
    },
    sql.withTransaction,
    Effect.mapError(storageError),
  );

  const resolve = Effect.fn("ThreadFolders.resolve")(
    function* (input: FolderChoice) {
      if (input.folderId === null) return null;
      if (input.folderId !== undefined) {
        const rows = yield* sql`SELECT 1 FROM argona_thread_folders WHERE id = ${input.folderId}`;
        if (rows.length > 0) return input.folderId;
        if (input.allowMissing === true) return null;
        return yield* missing(input.folderId);
      }
      if (input.parentThreadId === undefined) return null;
      const rows = yield* sql<{ folder_id: string }>`
      SELECT folder_id FROM argona_thread_folder_assignments WHERE thread_id = ${input.parentThreadId}`;
      return rows[0]?.folder_id ?? null;
    },
    Effect.catchTags({ SqlError: () => Effect.fail(storageError()) }),
  );

  const assign = Effect.fn("ThreadFolders.assign")(function* (
    threadId: ThreadId,
    folderId: string | null,
  ) {
    const rows =
      folderId === null
        ? yield* sql`DELETE FROM argona_thread_folder_assignments WHERE thread_id = ${threadId} RETURNING thread_id`
        : yield* sql`INSERT INTO argona_thread_folder_assignments (thread_id, folder_id)
          VALUES (${threadId}, ${folderId})
          ON CONFLICT(thread_id) DO UPDATE SET folder_id = excluded.folder_id
          WHERE folder_id != excluded.folder_id RETURNING thread_id`;
    if (rows.length > 0) yield* changed;
  }, Effect.mapError(storageError));

  const create = Effect.fn("ThreadFolders.create")(
    function* (input: { readonly name: string }) {
      const name = yield* normalizeName(input.name);
      const rows = yield* sql<ThreadFolder>`INSERT INTO argona_thread_folders (id, name, color)
      VALUES (lower(hex(randomblob(16))), ${name}, COALESCE((SELECT (color + 1) % 8 FROM argona_thread_folders ORDER BY rowid DESC LIMIT 1), 0))
      RETURNING id, name, color`;
      yield* changed;
      return rows[0]!;
    },
    sql.withTransaction,
    Effect.catchTags({ SqlError: () => Effect.fail(storageError()) }),
  );

  const rename = Effect.fn("ThreadFolders.rename")(
    function* (input: { readonly folderId: string; readonly name: string }) {
      const name = yield* normalizeName(input.name);
      const rows =
        yield* sql`UPDATE argona_thread_folders SET name = ${name} WHERE id = ${input.folderId} RETURNING id`;
      if (rows.length === 0) return yield* missing(input.folderId);
      yield* changed;
    },
    sql.withTransaction,
    Effect.catchTags({ SqlError: () => Effect.fail(storageError()) }),
  );

  const remove = Effect.fn("ThreadFolders.remove")(
    function* (input: { readonly folderId: string }) {
      yield* sql`DELETE FROM argona_thread_folder_assignments WHERE folder_id = ${input.folderId}`;
      const rows =
        yield* sql`DELETE FROM argona_thread_folders WHERE id = ${input.folderId} RETURNING id`;
      if (rows.length === 0) return yield* missing(input.folderId);
      yield* changed;
    },
    sql.withTransaction,
    Effect.catchTags({ SqlError: () => Effect.fail(storageError()) }),
  );

  const move = Effect.fn("ThreadFolders.move")(
    function* (input: typeof ThreadFolderMove.Type) {
      const threads = yield* sql`SELECT 1 FROM orchestration_v2_projection_threads
      WHERE thread_id = ${input.threadId} AND deleted_at IS NULL`;
      if (threads.length === 0)
        return yield* new ThreadFolderError({
          code: "not-found",
          message: "The thread does not exist.",
        });
      const folderId = yield* resolve(input);
      yield* assign(input.threadId, folderId);
    },
    sql.withTransaction,
    Effect.catchTags({ SqlError: () => Effect.fail(storageError()) }),
  );

  return {
    list,
    snapshot,
    subscribe: () => changes.stream(keys, snapshot()),
    resolve,
    assign,
    create,
    rename,
    remove,
    move,
  };
});

export class ThreadFolders extends Context.Service<ThreadFolders, Effect.Success<typeof make>>()(
  "t3/threadFolders",
) {}
export const layer = Layer.effect(ThreadFolders, make);
