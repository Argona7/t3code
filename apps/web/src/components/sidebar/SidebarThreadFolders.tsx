import type { ThreadFolder } from "@t3tools/contracts";
import { EllipsisIcon, FolderIcon, PlusIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { PROJECT_ICON_COLORS } from "../../projectIconColors";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const FOLDER_COLORS = ["blue", "purple", "rose", "orange", "emerald", "cyan", "amber", "lime"];
const tabClassName =
  "flex h-7 max-w-40 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-sidebar-row-active aria-pressed:text-sidebar-foreground";

type FolderEdit =
  | { readonly kind: "create" }
  | { readonly kind: "rename" | "delete"; readonly folder: ThreadFolder };

type Actions = {
  readonly onCreate: (name: string) => Promise<ThreadFolder | null>;
  readonly onRename: (folderId: string, name: string) => Promise<boolean>;
  readonly onDelete: (folderId: string) => Promise<boolean>;
};

export function SidebarThreadFolders(
  props: Actions & {
    readonly folders: readonly ThreadFolder[];
    readonly selectedFolderId: string | null;
    readonly showAll: boolean;
    readonly canManage: boolean;
    readonly onSelect: (folderId: string | null) => void;
  },
) {
  const [edit, setEdit] = useState<FolderEdit | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const { selectedFolderId, showAll } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals the restored or newly selected tab in the horizontal strip
  useEffect(() => {
    if (showAll) return;
    const strip = stripRef.current;
    const selected = strip?.querySelector(
      selectedFolderId === null
        ? "[data-thread-folder-all]"
        : `[data-thread-folder-id="${CSS.escape(selectedFolderId)}"]`,
    );
    if (!strip || !selected) return;
    const viewport = strip.getBoundingClientRect();
    const tab = selected.getBoundingClientRect();
    if (tab.right > viewport.right) strip.scrollLeft += tab.right - viewport.right;
    else if (tab.left < viewport.left) strip.scrollLeft += tab.left - viewport.left;
  }, [selectedFolderId, showAll]);
  return (
    <>
      <div role="group" aria-label="Thread folders" className="flex min-w-0 items-center gap-1">
        <div
          ref={stripRef}
          className="sidebar-thread-folders-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain py-1"
        >
          <button
            type="button"
            data-thread-folder-all
            aria-pressed={!props.showAll && props.selectedFolderId === null}
            className={tabClassName}
            onClick={() => props.onSelect(null)}
          >
            <FolderIcon aria-hidden className="size-3.5" />
            All
          </button>
          {props.folders.map((folder) => (
            <FolderTab
              key={folder.id}
              folder={folder}
              selected={!props.showAll && props.selectedFolderId === folder.id}
              canManage={props.canManage}
              onSelect={() => props.onSelect(folder.id)}
              onEdit={(kind) => setEdit({ kind, folder })}
            />
          ))}
        </div>
        {props.canManage ? (
          <div className="shrink-0">
            <Button
              aria-label="Add thread folder"
              size="icon-xs"
              variant="ghost-muted"
              onClick={() => setEdit({ kind: "create" })}
            >
              <PlusIcon />
            </Button>
          </div>
        ) : null}
      </div>
      {edit !== null && props.canManage ? (
        <FolderEditDialog
          edit={edit}
          onCreate={props.onCreate}
          onRename={props.onRename}
          onDelete={props.onDelete}
          onClose={() => setEdit(null)}
        />
      ) : null}
    </>
  );
}

function FolderTab(props: {
  readonly folder: ThreadFolder;
  readonly selected: boolean;
  readonly canManage: boolean;
  readonly onSelect: () => void;
  readonly onEdit: (kind: "rename" | "delete") => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { folder } = props;
  const color = PROJECT_ICON_COLORS.find(({ value }) => value === FOLDER_COLORS[folder.color]);
  return (
    <div
      className="flex shrink-0 items-center rounded-md data-[selected=true]:bg-sidebar-row-active"
      data-selected={props.selected}
      data-thread-folder-id={folder.id}
    >
      <Tooltip disabled={menuOpen}>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-pressed={props.selected}
              className={tabClassName}
              onClick={props.onSelect}
              onContextMenu={(event) => {
                if (!props.canManage) return;
                event.preventDefault();
                setMenuOpen(true);
              }}
              onKeyDown={(event) => {
                if (
                  !props.canManage ||
                  (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
                )
                  return;
                event.preventDefault();
                setMenuOpen(true);
              }}
            />
          }
        >
          <FolderIcon aria-hidden className={cn("size-3.5 shrink-0", color?.className)} />
          <span className="truncate">{folder.name}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">{folder.name}</TooltipPopup>
      </Tooltip>
      {props.canManage ? (
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label={`Folder actions for ${folder.name}`}
                className="flex h-7 w-6 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            <EllipsisIcon aria-hidden className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuItem onClick={() => props.onEdit("rename")}>Rename folder</MenuItem>
            <MenuItem variant="destructive" onClick={() => props.onEdit("delete")}>
              Delete folder
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}

function FolderEditDialog(
  props: Actions & { readonly edit: FolderEdit; readonly onClose: () => void },
) {
  const { edit, onClose } = props;
  const inputId = useId();
  const [name, setName] = useState(edit.kind === "create" ? "" : edit.folder.name);
  const [submitting, setSubmitting] = useState(false);
  const deleting = edit.kind === "delete";
  const title = deleting
    ? "Delete folder"
    : edit.kind === "rename"
      ? "Rename folder"
      : "Create thread folder";
  const action = deleting
    ? "Delete folder"
    : edit.kind === "rename"
      ? "Save name"
      : "Create folder";
  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    const succeeded = deleting
      ? await props.onDelete(edit.folder.id)
      : edit.kind === "rename"
        ? await props.onRename(edit.folder.id, name.trim())
        : (await props.onCreate(name.trim())) !== null;
    if (succeeded) onClose();
    else setSubmitting(false);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {deleting ? (
              <DialogDescription>
                Threads in “{edit.folder.name}” will move to All.
              </DialogDescription>
            ) : null}
          </DialogHeader>
          {!deleting ? (
            <DialogPanel>
              <div className="flex flex-col gap-2">
                <Label htmlFor={inputId}>Folder name</Label>
                <Input
                  id={inputId}
                  value={name}
                  maxLength={128}
                  onChange={(event) => setName(event.currentTarget.value)}
                  required
                />
              </div>
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={deleting ? "destructive" : "default"}
              disabled={submitting || (!deleting && name.trim().length === 0)}
            >
              {action}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
