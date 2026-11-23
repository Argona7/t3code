import { EnvironmentId, type ThreadFolderSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "./useLocalStorage";
import {
  getSelectedThreadFolderId,
  readThreadFolderMenuSnapshot,
  ThreadFolderSelection,
} from "./useThreadFolders";

const { primary, remote, offline } = vi.hoisted(() => ({
  primary: "folder-test-primary",
  remote: "folder-test-remote",
  offline: "folder-test-offline",
}));
const { snapshots, movePermissions } = vi.hoisted(() => ({
  snapshots: new Map<string, Atom.Writable<AsyncResult.AsyncResult<ThreadFolderSnapshot>>>(),
  movePermissions: new Map<string, Atom.Writable<boolean>>(),
}));

vi.mock("../state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { themeEnvironmentIdAtom: Atom.make(primary) };
});

vi.mock("../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentSummaries: {
      environmentIdsAtom: Atom.make([primary, remote, offline]),
      connectedEnvironmentIdsAtom: Atom.make([primary, remote]),
    },
  };
});

vi.mock("../state/server", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const pending = Atom.make(AsyncResult.initial());
  return {
    environmentServerConfigsAtom: Atom.make(
      new Map([
        [primary, { environment: { capabilities: { threadFolders: true } } }],
        [remote, { environment: { capabilities: { threadFolders: true } } }],
        [offline, { environment: { capabilities: {} } }],
      ]),
    ),
    serverEnvironment: {
      threadFoldersLive: ({ environmentId }: { environmentId: EnvironmentId }) =>
        snapshots.get(environmentId) ?? pending,
      moveThreadToFolder: {
        permissionAtom: (environmentId: EnvironmentId) =>
          movePermissions.get(environmentId) ?? Atom.make(false),
      },
    },
  };
});

it("waits for the clicked thread's machine to send its own catalog and checks move access", async () => {
  const localCatalog = {
    revision: 1,
    folders: [{ id: "same-id", name: "Air", color: 0 }],
    assignments: {},
  };
  const proCatalog = {
    revision: 2,
    folders: [{ id: "same-id", name: "Pro", color: 1 }],
    assignments: { "same-thread": "same-id" },
  };
  const remoteId = EnvironmentId.make(remote);
  const remotePermission = Atom.make(true);
  const remoteSnapshot = Atom.make<AsyncResult.AsyncResult<ThreadFolderSnapshot>>(
    AsyncResult.initial(),
  );
  const request = new AbortController();
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    snapshots.clear();
    movePermissions.clear();
  });
  snapshots.set(
    primary,
    Atom.make<AsyncResult.AsyncResult<ThreadFolderSnapshot>>(AsyncResult.success(localCatalog)),
  );
  snapshots.set(remote, remoteSnapshot);
  movePermissions.set(remote, remotePermission);

  const menu = readThreadFolderMenuSnapshot(remoteId, "thread", request.signal);
  appAtomRegistry.set(remoteSnapshot, AsyncResult.success(proCatalog));
  expect(await menu).toEqual(proCatalog);
  expect(
    await readThreadFolderMenuSnapshot(EnvironmentId.make(primary), "thread", request.signal),
  ).toBeNull();
  expect(
    await readThreadFolderMenuSnapshot(EnvironmentId.make(offline), "thread", request.signal),
  ).toBeNull();

  appAtomRegistry.set(remotePermission, false);
  expect(await readThreadFolderMenuSnapshot(remoteId, "thread", request.signal)).toBeNull();
  expect(await readThreadFolderMenuSnapshot(remoteId, "draft", request.signal)).toEqual(proCatalog);
});

describe("new drafts' thread folder", () => {
  it("uses the destination machine's selection for a remote draft while the local server is primary", () => {
    using cleanup = new DisposableStack();
    const remoteKey = `t3code:sidebar:thread-folders:${remote}`;
    const primaryKey = `t3code:sidebar:thread-folders:${primary}`;
    cleanup.defer(() => removeLocalStorageItem(remoteKey));
    cleanup.defer(() => removeLocalStorageItem(primaryKey));
    setLocalStorageItem(
      remoteKey,
      { folderId: "pro-work", allMode: "unfiled" },
      ThreadFolderSelection,
    );
    setLocalStorageItem(
      primaryKey,
      { folderId: "local-work", allMode: "all" },
      ThreadFolderSelection,
    );
    expect(getSelectedThreadFolderId(EnvironmentId.make(remote))).toBe("pro-work");
    expect(getSelectedThreadFolderId(EnvironmentId.make(primary))).toBe("local-work");
  });
  it("keeps drafts in their selected folder when All is set to show every thread", () => {
    using cleanup = new DisposableStack();
    const key = `t3code:sidebar:thread-folders:${primary}`;
    cleanup.defer(() => removeLocalStorageItem(key));
    const legacy = Schema.Struct({
      folderId: Schema.NullOr(Schema.String),
      showAll: Schema.Boolean,
    });
    setLocalStorageItem(key, { folderId: "development", allMode: "all" }, ThreadFolderSelection);
    expect(getSelectedThreadFolderId(EnvironmentId.make(primary))).toBe("development");
    expect(getLocalStorageItem(key, legacy)).toEqual({ folderId: "development", showAll: false });
    setLocalStorageItem(key, { folderId: null, allMode: "all" }, ThreadFolderSelection);
    expect(getSelectedThreadFolderId(EnvironmentId.make(primary))).toBeNull();
    expect(getLocalStorageItem(key, legacy)).toEqual({ folderId: null, showAll: true });
  });

  it("retains the primary selection while folders load, even with another registered environment", () => {
    using cleanup = new DisposableStack();
    const primaryKey = `t3code:sidebar:thread-folders:${primary}`;
    const offlineKey = `t3code:sidebar:thread-folders:${offline}`;
    const selection = Schema.Struct({ folderId: Schema.String, showAll: Schema.Boolean });
    cleanup.defer(() => removeLocalStorageItem(primaryKey));
    cleanup.defer(() => removeLocalStorageItem(offlineKey));
    setLocalStorageItem(primaryKey, { folderId: "development", showAll: false }, selection);
    setLocalStorageItem(offlineKey, { folderId: "offline-folder", showAll: false }, selection);

    expect(getSelectedThreadFolderId(EnvironmentId.make(primary))).toBe("development");
    expect(getSelectedThreadFolderId(EnvironmentId.make(offline))).toBeNull();

    setLocalStorageItem(primaryKey, { folderId: "development", showAll: true }, selection);
    expect(getSelectedThreadFolderId(EnvironmentId.make(primary))).toBeNull();
  });
});
