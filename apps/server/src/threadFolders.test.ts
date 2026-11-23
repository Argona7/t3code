import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { runMigrations } from "./persistence/Migrations.ts";
import * as ThreadFolders from "./threadFolders.ts";

it.effect("moves a whole batch once and pages only live members", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const first = ThreadId.make("first");
    const second = ThreadId.make("second");
    const third = ThreadId.make("third");
    const deleted = ThreadId.make("deleted");
    for (const id of [first, second, third, deleted]) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         created_at, updated_at, deleted_at, payload_json)
        VALUES (${id}, 'project', ${id}, 'codex', 'full-access', 'default', 'now', 'now',
          ${id === deleted ? "now" : null}, '{}')`;
    }
    const folders = yield* ThreadFolders.make;
    const { id: folderId, name } = yield* folders.create({ name: "Batch" });
    for (const threadId of [ThreadId.make("absent"), deleted]) {
      const failed = yield* folders
        .moveMany({ folderId, threadIds: [first, threadId, second] }, Effect.void)
        .pipe(Effect.flip);
      expect(failed.threadId).toBe(threadId);
    }
    const batch = { folderId, threadIds: [first, second, first] };
    const denied = yield* folders.moveMany(batch, Effect.fail("denied")).pipe(Effect.flip);
    expect(denied).toBe("denied");
    expect(yield* folders.snapshot()).toMatchObject({ revision: 1, assignments: {} });

    expect(yield* folders.moveMany(batch, Effect.void)).toEqual({
      folderId,
      threadIds: [first, second],
    });
    yield* folders.moveMany(batch, Effect.void);
    expect(yield* folders.snapshot()).toMatchObject({
      revision: 2,
      assignments: { [first]: folderId, [second]: folderId },
    });
    expect(yield* folders.members({ folderId, limit: 1 })).toEqual({
      folder: { id: folderId, name },
      threads: [{ threadId: first, projectId: "project", title: first }],
      nextCursor: first,
    });
    expect(yield* folders.members({ folderId, limit: 1, cursor: first })).toMatchObject({
      threads: [{ threadId: second }],
      nextCursor: null,
    });
    expect(yield* folders.membership(second)).toEqual({
      threadId: second,
      folder: { id: folderId, name },
    });
    expect(yield* folders.members({ folderId: null, limit: 5 })).toEqual({
      folder: null,
      threads: [{ threadId: third, projectId: "project", title: third }],
      nextCursor: null,
    });
    expect(yield* folders.membership(deleted).pipe(Effect.flip)).toMatchObject({
      threadId: deleted,
    });
    yield* folders.moveMany({ ...batch, folderId: null }, Effect.void);
    expect(yield* folders.snapshot()).toMatchObject({ revision: 3, assignments: {} });
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rechecks catalog write access inside the transaction for every action", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const folders = yield* ThreadFolders.make;
    const { id: folderId } = yield* folders.create({ name: "Original" });
    const before = yield* folders.snapshot();
    const sql = yield* SqlClient.SqlClient;
    const revoked = Effect.serviceOption(sql.transactionService).pipe(
      Effect.flatMap((transaction) =>
        Effect.fail(transaction._tag === "Some" ? "revoked" : "outside"),
      ),
    );
    for (const action of [
      folders.create({ name: "New" }, revoked),
      folders.rename({ folderId, name: "Renamed" }, revoked),
      folders.reorder({ folderId, beforeFolderId: null }, revoked),
      folders.remove({ folderId }, revoked),
    ]) {
      expect(yield* action.pipe(Effect.asVoid, Effect.flip)).toBe("revoked");
    }
    expect(yield* folders.snapshot()).toEqual(before);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps concurrent moves, refreshes two subscribers, and reopens the same database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const db = NodeSqliteClient.layer({
      filename: path.join(directory, "folders.sqlite"),
      readerWorker: true,
      writerWorker: true,
    });
    const first = ThreadId.make("first");
    const second = ThreadId.make("second");
    const { a, b } = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 96 });
      for (const id of [first, second]) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
           created_at, updated_at, payload_json)
          VALUES (${id}, 'project', 'Thread', 'codex', 'full-access', 'default', 'now', 'now', '{}')`;
      }
      yield* runMigrations();
      const folders = yield* ThreadFolders.make;
      expect(yield* folders.snapshot()).toEqual({ revision: 0, folders: [], assignments: {} });
      const a = yield* folders.create({ name: "Alpha" });
      const b = yield* folders.create({ name: "Beta" });
      const observeMoves = Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const observations = yield* folders.subscribe().pipe(
          Stream.tap(() => Deferred.succeed(ready, undefined)),
          Stream.takeUntil(
            (state) => state.assignments[first] === a.id && state.assignments[second] === b.id,
          ),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        return observations;
      });
      const clients = yield* Effect.all([observeMoves, observeMoves]);
      yield* Effect.all(
        [
          folders.move({ threadId: first, folderId: a.id }),
          folders.move({ threadId: second, folderId: b.id }),
        ],
        { concurrency: "unbounded" },
      );
      for (const client of clients) {
        const states = yield* Fiber.join(client);
        expect(states[0]?.assignments).toEqual({});
        expect(states.at(-1)?.assignments).toEqual({ [first]: a.id, [second]: b.id });
      }
      expect(yield* folders.resolve({ parentThreadId: first })).toBe(a.id);
      expect(yield* folders.resolve({ parentThreadId: first, folderId: null })).toBeNull();
      yield* folders.rename({ folderId: a.id, name: "Renamed" });
      expect(yield* sql`SELECT MAX(migration_id) AS head FROM effect_sql_migrations`).toEqual([
        { head: 96 },
      ]);
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (97, 'IssueTrackerBindings')`;
      return { a, b };
    }).pipe(Effect.provide(db), Effect.scoped);
    yield* Effect.gen(function* () {
      const folders = yield* ThreadFolders.make;
      expect(yield* folders.snapshot()).toEqual({
        revision: 5,
        folders: [{ ...a, name: "Renamed" }, b],
        assignments: { [first]: a.id, [second]: b.id },
      });
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 97`).toEqual([
        { name: "IssueTrackerBindings" },
      ]);
      yield* folders.remove({ folderId: a.id });
      expect(yield* folders.snapshot()).toEqual({
        revision: 6,
        folders: [b],
        assignments: { [second]: b.id },
      });
      expect(
        (yield* folders.move({ threadId: second, folderId: a.id }).pipe(Effect.flip)).message,
      ).toContain("does not exist");
      expect((yield* folders.snapshot()).assignments[second]).toBe(b.id);
    }).pipe(Effect.provide(db), Effect.scoped);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("updates the legacy folder order atomically and persists it across restarts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const db = NodeSqliteClient.layer({
      filename: path.join(directory, "folder-order.sqlite"),
      readerWorker: true,
      writerWorker: true,
    });
    const threadId = ThreadId.make("first");
    const alpha = { id: "alpha", name: "Alpha", color: 6 };
    const beta = { id: "beta", name: "Beta", color: 3 };
    const gamma = { id: "gamma", name: "Gamma", color: 2 };
    const expected = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`CREATE TABLE argona_thread_folders (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        color INTEGER NOT NULL CHECK (color BETWEEN 0 AND 7)
      )`;
      yield* sql`INSERT INTO argona_thread_folders (id, name, color) VALUES
        (${gamma.id}, ${gamma.name}, ${gamma.color}),
        (${alpha.id}, ${alpha.name}, ${alpha.color}),
        (${beta.id}, ${beta.name}, ${beta.color})`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         created_at, updated_at, payload_json)
        VALUES (${threadId}, 'project', 'Thread', 'codex', 'full-access', 'default', 'now', 'now', '{}')`;

      const folders = yield* ThreadFolders.make;
      const ready = yield* Deferred.make<void>();
      const subscription = yield* folders.subscribe().pipe(
        Stream.tap(() => Deferred.succeed(ready, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      yield* folders.reorder({ folderId: gamma.id, beforeFolderId: beta.id });
      expect(Array.from(yield* Fiber.join(subscription))).toEqual([
        { revision: 0, folders: [gamma, alpha, beta], assignments: {} },
        { revision: 1, folders: [alpha, gamma, beta], assignments: {} },
      ]);

      yield* folders.reorder({ folderId: gamma.id, beforeFolderId: beta.id });
      yield* folders.reorder({ folderId: gamma.id, beforeFolderId: gamma.id });
      yield* folders.reorder({ folderId: beta.id, beforeFolderId: null });
      expect((yield* folders.snapshot()).revision).toBe(1);

      const [newFolder] = yield* Effect.all(
        [
          folders.create({ name: "New" }),
          folders.reorder({ folderId: beta.id, beforeFolderId: alpha.id }),
          folders.rename({ folderId: gamma.id, name: "Renamed" }),
          folders.move({ threadId, folderId: gamma.id }),
        ],
        { concurrency: "unbounded" },
      );
      expect(newFolder.color).toBe(4);
      expect(yield* folders.snapshot()).toEqual({
        revision: 5,
        folders: [beta, alpha, { ...gamma, name: "Renamed" }, newFolder],
        assignments: { [threadId]: gamma.id },
      });

      yield* folders.remove({ folderId: alpha.id });
      for (const input of [
        { folderId: alpha.id, beforeFolderId: beta.id },
        { folderId: beta.id, beforeFolderId: alpha.id },
      ]) {
        expect((yield* folders.reorder(input).pipe(Effect.flip)).code).toBe("not-found");
      }
      yield* folders.reorder({ folderId: beta.id, beforeFolderId: null });
      return {
        revision: 7,
        folders: [{ ...gamma, name: "Renamed" }, newFolder, beta],
        assignments: { [threadId]: gamma.id },
      };
    }).pipe(Effect.provide(db), Effect.scoped);
    yield* Effect.gen(function* () {
      const folders = yield* ThreadFolders.make;
      expect(yield* folders.snapshot()).toEqual(expected);
    }).pipe(Effect.provide(db), Effect.scoped);
  }).pipe(Effect.provide(NodeServices.layer)),
);
