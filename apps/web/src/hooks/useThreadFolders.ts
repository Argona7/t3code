import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ThreadFolder,
  ThreadFolderSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { readLocalStorageValue, useLocalStorage } from "./useLocalStorage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "../state/presentation";
import { themeEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuerySelector } from "../state/query";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

const Selection = Schema.Struct({
  folderId: Schema.NullOr(Schema.String),
  showAll: Schema.Boolean,
});
const DEFAULT_SELECTION = { folderId: null, showAll: false } satisfies typeof Selection.Type;
const EMPTY_FOLDERS: readonly ThreadFolder[] = [];
const EMPTY_ASSIGNMENTS: Readonly<Record<string, string>> = {};

const folderEnvironmentAtom = Atom.make((get) => {
  const environments = get(environmentSummaries.environmentIdsAtom);
  const preferred = get(themeEnvironmentIdAtom);
  const connected =
    preferred === null && environments.length > 1
      ? get(environmentSummaries.connectedEnvironmentIdsAtom)
      : environments;
  const environmentId = preferred ?? (connected.length === 1 ? connected[0]! : null);
  if (environmentId === null) return null;
  return get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
    .threadFolders === true
    ? environmentId
    : null;
});

function selectionKey(environmentId: EnvironmentId | null) {
  return `t3code:sidebar:thread-folders:${environmentId ?? "disconnected"}`;
}

function snapshotAtom(environmentId: EnvironmentId) {
  return serverEnvironment.threadFoldersLive({ environmentId, input: {} });
}

function snapshotValue<E>(snapshot: AsyncResult.AsyncResult<ThreadFolderSnapshot, E>) {
  return AsyncResult.getOrElse(snapshot, () => null);
}

function knownFolderId(folders: readonly ThreadFolder[], folderId: string | null) {
  return folders.some((folder) => folder.id === folderId) ? folderId : null;
}

export function resolveThreadFolderId(environmentId: EnvironmentId, folderId: string | null) {
  if (
    folderId === null ||
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadFolders !== true
  )
    return folderId;
  const snapshot = snapshotValue(appAtomRegistry.get(snapshotAtom(environmentId)));
  return snapshot ? knownFolderId(snapshot.folders, folderId) : folderId;
}

export function getSelectedThreadFolderId(environmentId: EnvironmentId) {
  if (appAtomRegistry.get(folderEnvironmentAtom) !== environmentId) return null;
  const selection = readLocalStorageValue(
    selectionKey(environmentId),
    DEFAULT_SELECTION,
    Selection,
  );
  return selection.showAll ? null : resolveThreadFolderId(environmentId, selection.folderId);
}

async function reportFolderMutation<A, E>(
  action: Promise<AtomCommandResult<A, E>>,
  title: string,
): Promise<{ readonly value: A } | null> {
  const result = await action;
  if (result._tag === "Success") return result;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "The environment request failed.",
      }),
    );
  }
  return null;
}

export function useThreadFolders() {
  const environmentId = useAtomValue(folderEnvironmentAtom);
  const snapshot = useEnvironmentQuerySelector(
    environmentId === null ? null : snapshotAtom(environmentId),
    snapshotValue,
  );
  const [selection, setSelection] = useLocalStorage(
    selectionKey(environmentId),
    DEFAULT_SELECTION,
    Selection,
  );
  const canManage = useAtomValue(
    serverEnvironment.createThreadFolder.permissionAtom(environmentId),
  );
  const create = useAtomCommand(serverEnvironment.createThreadFolder, { reportFailure: false });
  const rename = useAtomCommand(serverEnvironment.renameThreadFolder, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.deleteThreadFolder, { reportFailure: false });
  const move = useAtomCommand(serverEnvironment.moveThreadToFolder, { reportFailure: false });
  const folders = snapshot?.folders ?? EMPTY_FOLDERS;
  const folderId =
    snapshot === null ? selection.folderId : knownFolderId(folders, selection.folderId);
  const draftFolderScope = environmentId === null || selection.showAll ? undefined : folderId;
  const scope =
    environmentId === null || selection.showAll || (snapshot === null && folderId === null)
      ? undefined
      : {
          environmentId,
          folderId,
          assignments: snapshot?.assignments ?? EMPTY_ASSIGNMENTS,
          revision: snapshot?.revision ?? null,
        };
  return {
    environmentId,
    ready: snapshot !== null,
    canManage,
    folders,
    assignments: snapshot?.assignments,
    scope,
    draftFolderScope,
    folderId,
    showAll: selection.showAll,
    selectFolder: (next: string | null) => setSelection({ folderId: next, showAll: false }),
    toggleShowAll: () => setSelection((current) => ({ ...current, showAll: !current.showAll })),
    create: async (name: string) =>
      environmentId === null
        ? null
        : ((
            await reportFolderMutation(
              create({ environmentId, input: { name } }),
              "Could not create folder",
            )
          )?.value ?? null),
    rename: async (folderId: string, name: string) =>
      environmentId !== null &&
      (await reportFolderMutation(
        rename({ environmentId, input: { folderId, name } }),
        "Could not rename folder",
      )) !== null,
    remove: async (folderId: string) =>
      environmentId !== null &&
      (await reportFolderMutation(
        remove({ environmentId, input: { folderId } }),
        "Could not delete folder",
      )) !== null,
    move: async (threadId: ThreadId, folderId: string | null) =>
      environmentId !== null &&
      (await reportFolderMutation(
        move({ environmentId, input: { threadId, folderId } }),
        "Could not move thread",
      )) !== null,
  };
}
