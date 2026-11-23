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
