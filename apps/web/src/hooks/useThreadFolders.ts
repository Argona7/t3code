import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadFolder,
  ThreadFolderSnapshot,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { AsyncResult, Atom } from "effect/reactivity";
import { readLocalStorageValue, useLocalStorage } from "./useLocalStorage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "../state/presentation";
import { themeEnvironmentIdAtom } from "../state/primaryEnvironment";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuerySelector } from "../state/query";
import { waitForQuerySettled } from "../state/waitForQuerySettled";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

const LegacySelection = Schema.Struct({
  folderId: Schema.NullOr(Schema.String),
  showAll: Schema.Boolean,
});
const FolderSelection = Schema.Struct({
  folderId: Schema.NullOr(Schema.String),
  allMode: Schema.Literals(["all", "unfiled"]),
});
const StoredSelection = Schema.Struct({
  ...FolderSelection.fields,
  showAll: Schema.optionalKey(Schema.Boolean),
});
export const ThreadFolderSelection = Schema.Union([StoredSelection, LegacySelection]).pipe(
  Schema.decodeTo(FolderSelection, {
    decode: SchemaGetter.transform((value) => {
      if ("allMode" in value) return value;
      // Older clients could remember a custom ID while the global filter was active.
      return value.showAll
        ? { folderId: null, allMode: "all" as const }
        : { folderId: value.folderId, allMode: "unfiled" as const };
    }),
    // Older clients sharing this storage key read showAll as the active view.
    encode: SchemaGetter.transform((value) => ({
      ...value,
      showAll: value.folderId === null && value.allMode === "all",
    })),
  }),
);
const DEFAULT_SELECTION = {
  folderId: null,
  allMode: "unfiled",
} satisfies typeof FolderSelection.Type;

const EMPTY_FOLDERS: readonly ThreadFolder[] = [];
const EMPTY_ASSIGNMENTS: Readonly<Record<string, string>> = {};

const defaultFolderEnvironmentAtom = Atom.make((get) => {
  const environments = get(environmentSummaries.environmentIdsAtom);
  const preferred = get(themeEnvironmentIdAtom);
  const connected =
    preferred === null && environments.length > 1
      ? get(environmentSummaries.connectedEnvironmentIdsAtom)
      : environments;
  return preferred ?? (connected.length === 1 ? connected[0]! : null);
});

const folderCapabilitiesAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) =>
    environmentId === null
      ? undefined
      : get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities,
  ),
);

function selectionKey(environmentId: EnvironmentId | null) {
  return `t3code:sidebar:thread-folders:${environmentId ?? "disconnected"}`;
}

function snapshotAtom(environmentId: EnvironmentId) {
  return serverEnvironment.threadFoldersLive({ environmentId, input: {} });
}

function snapshotValue<E>(snapshot: AsyncResult.AsyncResult<ThreadFolderSnapshot, E>) {
  return AsyncResult.getOrElse(snapshot, () => null);
}

export async function readThreadFolderMenuSnapshot(
  environmentId: EnvironmentId,
  kind: "thread" | "draft",
  signal: AbortSignal,
) {
  const available = () =>
    !signal.aborted &&
    appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom).includes(environmentId) &&
    appAtomRegistry.get(folderCapabilitiesAtom(environmentId))?.threadFolders === true &&
    (kind === "draft" ||
      appAtomRegistry.get(serverEnvironment.moveThreadToFolder.permissionAtom(environmentId)));
  if (!available()) return null;
  // An unopened remote catalog has no sidebar subscription. Give its first
  // snapshot a bounded wait so a dropped connection cannot block the menu.
  const snapshot = await waitForQuerySettled({
    registry: appAtomRegistry,
    atom: snapshotAtom(environmentId),
    settle: (snapshot) => snapshot ?? undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
  });
  return available() ? (snapshot ?? null) : null;
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
  if (appAtomRegistry.get(folderCapabilitiesAtom(environmentId))?.threadFolders !== true)
    return null;
  const selection = readLocalStorageValue(
    selectionKey(environmentId),
    DEFAULT_SELECTION,
    ThreadFolderSelection,
  );
  return resolveThreadFolderId(environmentId, selection.folderId);
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

export function useThreadFolders(shownEnvironmentId: EnvironmentId | null) {
  const defaultEnvironmentId = useAtomValue(defaultFolderEnvironmentAtom);
  // Desktop can host its own server while showing a thread on another Mac.
  const target = shownEnvironmentId ?? defaultEnvironmentId;
  const capabilities = useAtomValue(folderCapabilitiesAtom(target));
  const environmentId = capabilities?.threadFolders === true ? target : null;
  const snapshot = useEnvironmentQuerySelector(
    environmentId === null ? null : snapshotAtom(environmentId),
    snapshotValue,
  );
  const [selection, setSelection] = useLocalStorage(
    selectionKey(environmentId),
    DEFAULT_SELECTION,
    ThreadFolderSelection,
  );
  const supportsReorder = capabilities?.threadFolderReorder === true;
  const canReorder = useAtomValue(
    serverEnvironment.reorderThreadFolder.permissionAtom(environmentId),
  );
  const reorder = useAtomCommand(serverEnvironment.reorderThreadFolder, { reportFailure: false });
  const canManage = useAtomValue(
    serverEnvironment.createThreadFolder.permissionAtom(environmentId),
  );
  const create = useAtomCommand(serverEnvironment.createThreadFolder, { reportFailure: false });
  const rename = useAtomCommand(serverEnvironment.renameThreadFolder, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.deleteThreadFolder, { reportFailure: false });
  const move = useAtomCommand(serverEnvironment.moveThreadToFolder, { reportFailure: false });
  const canMove = useAtomValue(serverEnvironment.moveThreadToFolder.permissionAtom(environmentId));
  const folders = snapshot?.folders ?? EMPTY_FOLDERS;
  const folderId =
    snapshot === null ? selection.folderId : knownFolderId(folders, selection.folderId);
  const showAll = selection.allMode === "all";
  const isAllThreadsView = folderId === null && showAll;
  const draftFolderScope = environmentId === null || isAllThreadsView ? undefined : folderId;
  const scope =
    environmentId === null || isAllThreadsView || (snapshot === null && folderId === null)
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
    canMove,
    scope,
    draftFolderScope,
    folderId,
    showAll,
    isAllThreadsView,
    selectFolder: (folderId: string | null) =>
      setSelection((current) => ({ ...current, folderId })),
    selectAllMode: (all: boolean) =>
      setSelection({ folderId: null, allMode: all ? "all" : "unfiled" }),
    canReorder: supportsReorder && canReorder,
    reorder: async (folderId: string, beforeFolderId: string | null) =>
      environmentId !== null &&
      supportsReorder &&
      canReorder &&
      (await reportFolderMutation(
        reorder({ environmentId, input: { folderId, beforeFolderId } }),
        "Could not reorder folders",
      )) !== null,
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
    move: async ({ environmentId, threadId }: ScopedThreadRef, folderId: string | null) =>
      (await reportFolderMutation(
        move({ environmentId, input: { threadId, folderId } }),
        "Could not move thread",
      )) !== null,
  };
}
