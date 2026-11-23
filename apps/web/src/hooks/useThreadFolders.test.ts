import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { removeLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";
import { getSelectedThreadFolderId } from "./useThreadFolders";

const { primary, offline } = vi.hoisted(() => ({
  primary: "folder-test-primary",
  offline: "folder-test-offline",
}));

vi.mock("../state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { themeEnvironmentIdAtom: Atom.make(primary) };
});

vi.mock("../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentSummaries: {
      environmentIdsAtom: Atom.make([primary, offline]),
      connectedEnvironmentIdsAtom: Atom.make([primary]),
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
        [offline, { environment: { capabilities: {} } }],
      ]),
    ),
    serverEnvironment: { threadFoldersLive: () => pending },
  };
});

describe("new drafts' thread folder", () => {
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
