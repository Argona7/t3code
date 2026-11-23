import { initializeThreadFolderSchema } from "./persistence/threadFolderSchema.ts";

import {
  ThreadFolderError,
  ThreadFolderName,
  type ThreadFolder,
  type ThreadFolderCatalogEntry,
  type ThreadFolderCreate,
  type ThreadFolderRename,
  type ThreadFolderDelete,
  type ThreadFolderMember,
  type ThreadFolderMove,
  type ThreadFolderReorder,
  type ThreadFolderSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

export interface FolderChoice {
  readonly folderId?: string | null;
  readonly parentThreadId?: ThreadId;
  readonly allowMissing?: boolean;
}

interface FolderAssignments {
  readonly folderId: string | null;
  readonly threadIds: ReadonlyArray<ThreadId>;
}

const storageError = () =>
  new ThreadFolderError({ code: "storage", message: "Could not access thread folders." });

const missing = (folderId: string) =>
  new ThreadFolderError({
    code: "not-found",
    message: `Thread folder ${folderId} does not exist.`,
  });

const missingThread = (threadId: ThreadId) =>
  new ThreadFolderError({
    code: "not-found",
    message: `Thread ${threadId} does not exist.`,
    threadId,
  });

const decodeFolderName = Schema.decodeEffect(ThreadFolderName);
const encodeFolderIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
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
    return yield* sql<ThreadFolder>`SELECT id, name, color FROM argona_thread_folders
      ORDER BY display_order NULLS LAST, rowid`;
  }, Effect.mapError(storageError));

  const membership = Effect.fn("ThreadFolders.membership")(
    function* (threadId: ThreadId) {
      const [row] = yield* sql<{ id: string | null; name: string | null }>`
        SELECT f.id, f.name
        FROM orchestration_v2_projection_threads t
        LEFT JOIN argona_thread_folder_assignments a ON a.thread_id = t.thread_id
        LEFT JOIN argona_thread_folders f ON f.id = a.folder_id
        WHERE t.thread_id = ${threadId} AND t.deleted_at IS NULL`;
      if (row === undefined) return yield* missingThread(threadId);
      const folder = row.id === null || row.name === null ? null : { id: row.id, name: row.name };
      return { threadId, folder };
    },
    NodeSqliteClient.readOnly,
    Effect.catchTags({ SqlError: () => Effect.fail(storageError()) }),
  );

  const members = Effect.fn("ThreadFolders.members")(
    function* ({
      folderId,
      cursor,
      limit,
    }: {
      readonly folderId: string | null;
      readonly cursor?: ThreadId | undefined;
      readonly limit: number;
    }) {
      let folder: typeof ThreadFolderCatalogEntry.Type | null = null;
      if (folderId !== null) {
        const [entry] = yield* sql<typeof ThreadFolderCatalogEntry.Type>`
          SELECT id, name FROM argona_thread_folders WHERE id = ${folderId}`;
        if (entry === undefined) return yield* missing(folderId);
        folder = entry;
      }
      const after = cursor === undefined ? sql`` : sql`AND t.thread_id > ${cursor}`;
      const members =
        folderId === null
          ? sql`LEFT JOIN argona_thread_folder_assignments a ON a.thread_id = t.thread_id
            WHERE a.thread_id IS NULL`
          : sql`JOIN argona_thread_folder_assignments a ON a.thread_id = t.thread_id
            WHERE a.folder_id = ${folderId}`;
      const rows = yield* sql<typeof ThreadFolderMember.Type>`
        SELECT t.thread_id AS "threadId", t.project_id AS "projectId", t.title
        FROM orchestration_v2_projection_threads t
        ${members} AND t.deleted_at IS NULL ${after}
        ORDER BY t.thread_id LIMIT ${limit + 1}`;
      const threads = rows.slice(0, limit);
      return {
        folder,
        threads,
        nextCursor: (rows.length > limit ? threads.at(-1)?.threadId : undefined) ?? null,
      };
    },
    sql.withTransaction,
    NodeSqliteClient.readOnly,
    Effect.catchTags({ SqlError: () => Effect.fail(storageError()) }),
  );

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

  // An agent can lose access while waiting for SQLite's writer. Check under the same lock.
  function catalogWrite<I, A>(
    operation: (input: I) => Effect.Effect<A, SqlError.SqlError | ThreadFolderError>,
  ) {
    function run(input: I): Effect.Effect<A, ThreadFolderError>;
    function run<E, R>(
      input: I,
      authorize: Effect.Effect<unknown, E, R>,
    ): Effect.Effect<A, E | ThreadFolderError, R>;
    function run<E, R>(input: I, authorize: Effect.Effect<unknown, E, R> = Effect.void) {
      return sql
        .withTransaction(Effect.andThen(authorize, operation(input)))
        .pipe(Effect.catchIf(SqlError.isSqlError, () => Effect.fail(storageError())));
    }
    return run;
  }

  const create = catalogWrite(
    Effect.fn("ThreadFolders.create")(function* (input: typeof ThreadFolderCreate.Type) {
      const name = yield* normalizeName(input.name);
      const rows = yield* sql<ThreadFolder>`INSERT INTO argona_thread_folders (id, name, color)
      VALUES (lower(hex(randomblob(16))), ${name}, COALESCE((SELECT (color + 1) % 8 FROM argona_thread_folders ORDER BY rowid DESC LIMIT 1), 0))
      RETURNING id, name, color`;
      yield* changed;
      return rows[0]!;
    }),
  );

  const rename = catalogWrite(
    Effect.fn("ThreadFolders.rename")(function* (input: typeof ThreadFolderRename.Type) {
      const name = yield* normalizeName(input.name);
      const rows =
        yield* sql`UPDATE argona_thread_folders SET name = ${name} WHERE id = ${input.folderId} RETURNING id`;
      if (rows.length === 0) return yield* missing(input.folderId);
      yield* changed;
    }),
  );

  const remove = catalogWrite(
    Effect.fn("ThreadFolders.remove")(function* (input: typeof ThreadFolderDelete.Type) {
      yield* sql`DELETE FROM argona_thread_folder_assignments WHERE folder_id = ${input.folderId}`;
      const rows =
        yield* sql`DELETE FROM argona_thread_folders WHERE id = ${input.folderId} RETURNING id`;
      if (rows.length === 0) return yield* missing(input.folderId);
      yield* changed;
    }),
  );

  const moveMany: <E, R>(
    input: FolderAssignments,
    authorize: Effect.Effect<unknown, E, R>,
  ) => Effect.Effect<FolderAssignments, E | ThreadFolderError, R> = Effect.fn(
    "ThreadFolders.moveMany",
  )(
    function* <E = never, R = never>(
      input: FolderAssignments,
      authorize: Effect.Effect<unknown, E, R>,
    ) {
      const threadIds = [...new Set(input.threadIds)];
      const threads = yield* sql<{ thread_id: ThreadId }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE thread_id IN ${sql.in(threadIds)} AND deleted_at IS NULL`;
      const existing = new Set(threads.map(({ thread_id }) => thread_id));
      const absent = threadIds.find((threadId) => !existing.has(threadId));
      if (absent !== undefined) return yield* missingThread(absent);
      yield* authorize;
      const folderId = yield* resolve(input);
      const moved =
        folderId === null
          ? yield* sql`DELETE FROM argona_thread_folder_assignments
            WHERE thread_id IN ${sql.in(threadIds)} RETURNING thread_id`
          : yield* sql`INSERT INTO argona_thread_folder_assignments (thread_id, folder_id)
            SELECT thread_id, ${folderId} FROM orchestration_v2_projection_threads
            WHERE thread_id IN ${sql.in(threadIds)}
            ON CONFLICT(thread_id) DO UPDATE SET folder_id = excluded.folder_id
            WHERE folder_id != excluded.folder_id RETURNING thread_id`;
      if (moved.length > 0) yield* changed;
      return { folderId, threadIds };
    },
    sql.withTransaction,
    Effect.catchIf(SqlError.isSqlError, () => Effect.fail(storageError())),
  );

  const move = (input: typeof ThreadFolderMove.Type) =>
    moveMany({ threadIds: [input.threadId], folderId: input.folderId }, Effect.void).pipe(
      Effect.asVoid,
    );

  const reorder = catalogWrite(
    Effect.fn("ThreadFolders.reorder")(function* ({
      folderId,
      beforeFolderId,
    }: typeof ThreadFolderReorder.Type) {
      const ids = (yield* list()).map(({ id }) => id);
      const from = ids.indexOf(folderId);
      if (from === -1) return yield* missing(folderId);
      if (folderId === beforeFolderId) return;
      ids.splice(from, 1);
      const to = beforeFolderId === null ? ids.length : ids.indexOf(beforeFolderId);
      if (beforeFolderId !== null && to === -1) return yield* missing(beforeFolderId);
      if (from === to) return;
      ids.splice(to, 0, folderId);
      const order = yield* encodeFolderIds(ids).pipe(Effect.mapError(storageError));
      yield* sql`UPDATE argona_thread_folders SET display_order = ordering.key
        FROM json_each(${order}) AS ordering
        WHERE argona_thread_folders.id = ordering.value AND display_order IS NOT ordering.key`;
      yield* changed;
    }),
  );

  return {
    list,
    membership,
    members,
    snapshot,
    subscribe: () => changes.stream(keys, snapshot()),
    resolve,
    assign,
    create,
    rename,
    remove,
    move,
    moveMany,
    reorder,
  };
});

export class ThreadFolders extends Context.Service<ThreadFolders, Effect.Success<typeof make>>()(
  "t3/threadFolders",
) {}
export const layer = Layer.effect(ThreadFolders, make);
