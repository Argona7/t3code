import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Profiler } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { formatAssistantCitationForComposer } from "../../composer-logic";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { SidebarDraftBlock } from "./SidebarDraftBlock";

it("keeps draft previews current through edits, promotion and removal", async () => {
  const initial = useComposerDraftStore.getState();
  using _store = {
    [Symbol.dispose]: () => useComposerDraftStore.setState(initial, true),
  };
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const environmentId = EnvironmentId.make("draft-preview-environment");
  const projectRef = scopeProjectRef(environmentId, ProjectId.make("draft-preview-project"));
  const draftId = DraftId.make("draft-preview");
  const threadId = ThreadId.make("draft-preview-thread");
  const onRender = vi.fn();
  await using screen = await render(
    <Profiler id="draft-block" onRender={onRender}>
      <ul>
        <SidebarDraftBlock
          projectByKey={new Map()}
          projectDisplayNameByKey={new Map()}
          scopedProjectKeys={null}
          routeDraftId={null}
          onNavigateToDraft={vi.fn()}
          onDraftContextMenu={vi.fn()}
        />
      </ul>
    </Profiler>,
  );
  const row = screen.getByTestId("sidebar-draft-row");
  await expect.element(row).not.toBeInTheDocument();

  await act(() => {
    initial.setProjectDraftThreadId(projectRef, draftId, { threadId });
    initial.setPrompt(draftId, "First draft preview");
  });
  await expect.element(row).toHaveAccessibleName("First draft preview, Unsent draft");

  const rendersBeforeOtherComposer = onRender.mock.calls.length;
  await act(() =>
    initial.setPrompt(scopeThreadRef(environmentId, ThreadId.make("other")), "Other composer"),
  );
  expect(onRender).toHaveBeenCalledTimes(rendersBeforeOtherComposer);
  await act(() => initial.setPrompt(draftId, "Updated draft preview"));
  await expect.element(row).toHaveAccessibleName("Updated draft preview, Unsent draft");

  const quote = "Cache the parsed config per worktree.";
  const citation = formatAssistantCitationForComposer({
    version: 1,
    environmentId,
    threadId: ThreadId.make("source-thread"),
    messageId: MessageId.make("source-message"),
    text: quote,
    start: 0,
    end: quote.length,
    prefix: "",
    suffix: "",
  });
  await act(() => initial.setPrompt(draftId, `${citation}Why per worktree?`));
  await expect.element(row).toHaveAccessibleName(`${quote} Why per worktree?, Unsent draft`);

  await act(() => initial.markDraftThreadPromoting(draftId));
  await expect.element(row).not.toBeInTheDocument();
  await act(() => initial.clearDraftThread(draftId));

  const nextDraftId = DraftId.make("next-draft-preview");
  await act(() => {
    initial.setProjectDraftThreadId(projectRef, nextDraftId, { threadId: ThreadId.make("next") });
    initial.setPrompt(nextDraftId, "Next draft preview");
  });
  await expect.element(row).toHaveAccessibleName("Next draft preview, Unsent draft");
  await act(() => initial.clearDraftThread(nextDraftId));
  await expect.element(row).not.toBeInTheDocument();
});

it("hides an active draft immediately when it moves out of the viewed folder", async () => {
  const initial = useComposerDraftStore.getState();
  using _store = {
    [Symbol.dispose]: () => useComposerDraftStore.setState(initial, true),
  };
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const environmentId = EnvironmentId.make("draft-folder-environment");
  const projectRef = scopeProjectRef(environmentId, ProjectId.make("draft-folder-project"));
  const draftId = DraftId.make("folder-draft");
  initial.setProjectDraftThreadId(projectRef, draftId, {
    threadId: ThreadId.make("folder-draft-thread"),
    folderId: "folder-a",
  });
  initial.setPrompt(draftId, "Draft that stays private to its folder");
  const folders = [
    { id: "folder-a", name: "Folder A", color: 0 },
    { id: "folder-b", name: "Folder B", color: 1 },
  ];
  const onNavigateToDraft = vi.fn();
  const onDraftContextMenu = vi.fn();
  const renderBlock = (folderScope: string | null | undefined, visibleFolders = folders) => (
    <ul>
      <SidebarDraftBlock
        projectByKey={new Map()}
        projectDisplayNameByKey={new Map()}
        scopedProjectKeys={null}
        routeDraftId={draftId}
        onNavigateToDraft={onNavigateToDraft}
        onDraftContextMenu={onDraftContextMenu}
        folderScope={folderScope}
        folderScopeEnvironmentId={environmentId}
        folders={visibleFolders}
      />
    </ul>
  );
  await using screen = await render(renderBlock("folder-a"));
  const row = screen.getByTestId("sidebar-draft-row");
  await expect.element(row).toBeInTheDocument();
  await screen.getByRole("button", { name: "Draft actions" }).click();
  expect(onDraftContextMenu).toHaveBeenCalledWith(draftId, expect.any(Object), "mouse");
  expect(onNavigateToDraft).not.toHaveBeenCalled();

  await act(() => initial.setDraftThreadFolder(draftId, "folder-b"));
  await expect.element(row).not.toBeInTheDocument();
  await screen.rerender(renderBlock(null));
  await expect.element(row).not.toBeInTheDocument();
  await screen.rerender(renderBlock("folder-b"));
  await expect.element(row).toBeInTheDocument();
  await screen.rerender(renderBlock(undefined));
  await expect.element(row).toBeInTheDocument();
  await screen.rerender(renderBlock(null, folders.slice(0, 1)));
  await expect.element(row).toBeInTheDocument();
});
