import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ThreadFolderName = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const ThreadFolder = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: ThreadFolderName,
  color: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })),
});
export type ThreadFolder = typeof ThreadFolder.Type;

export const ThreadFolderSnapshot = Schema.Struct({
  folders: Schema.Array(ThreadFolder),
  revision: Schema.Int,
  assignments: Schema.Record(Schema.String, Schema.String),
});
export type ThreadFolderSnapshot = typeof ThreadFolderSnapshot.Type;

export const ThreadFolderCreate = Schema.Struct({ name: ThreadFolderName });
export const ThreadFolderDelete = Schema.Struct({ folderId: TrimmedNonEmptyString });
export const ThreadFolderRename = Schema.Struct({
  ...ThreadFolderDelete.fields,
  name: ThreadFolderName,
});
export const ThreadFolderMove = Schema.Struct({
  threadId: ThreadId,
  folderId: Schema.NullOr(TrimmedNonEmptyString),
});

export class ThreadFolderError extends Schema.TaggedError<ThreadFolderError>()(
  "ThreadFolderError",
  {
    code: Schema.Literals(["not-found", "storage", "invalid-name"]),
    message: Schema.String,
  },
) {}
