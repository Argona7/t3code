import {
  closestCenter,
  DndContext,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type SensorProps,
  type TouchSensorOptions,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS as DndCss } from "@dnd-kit/utilities";
import type { ContextMenuItem, ContextMenuSource, ThreadFolder } from "@t3tools/contracts";
import { FolderIcon, PlusIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useStableCallback } from "../../hooks/useStableCallback";
import { readLocalApi } from "../../localApi";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const FOLDER_COLORS = ["blue", "purple", "rose", "orange", "emerald", "cyan", "amber", "lime"];
const DRAG_MODIFIERS = [restrictToHorizontalAxis];
const LONG_PRESS_MS = 500;
const TOUCH_MOVE_TOLERANCE = 8;
const tabClassName =
  "sidebar-thread-folder-tab relative flex h-7 max-w-40 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-sidebar-row-active aria-pressed:text-sidebar-foreground";

class FolderTouchSensor {
  static activators = TouchSensor.activators;
  static setup = TouchSensor.setup;
  private activeSensor: TouchSensor | undefined;

  get autoScrollEnabled() {
    return this.activeSensor?.autoScrollEnabled ?? false;
  }

  constructor(props: SensorProps<TouchSensorOptions>) {
    const start = props.event;
    if (!(start instanceof TouchEvent) || !start.target || start.touches.length !== 1) {
      props.onCancel();
      return;
    }
    const origin = start.touches[0]!;
    const pending = new AbortController();
    const stopPending = (finish: () => void) => {
      pending.abort();
      props.onAbort(props.active);
      finish();
    };

    start.target.addEventListener(
      "touchmove",
      (event) => {
        if (!(event instanceof TouchEvent) || event.touches.length !== 1) {
          stopPending(props.onCancel);
          return;
        }
        const { clientX: x, clientY: y } = event.touches[0]!;
        if (Math.hypot(x - origin.clientX, y - origin.clientY) <= TOUCH_MOVE_TOLERANCE) return;
        if (event.timeStamp - start.timeStamp < LONG_PRESS_MS || !event.cancelable) {
          stopPending(props.onCancel);
          return;
        }
        // A stationary hold never starts a drag or takes ownership of subsequent clicks.
        pending.abort();
        event.preventDefault();
        this.activeSensor = new TouchSensor(props);
        props.onMove({ x, y });
      },
      { passive: false, signal: pending.signal },
    );
    start.target.addEventListener("touchend", () => stopPending(props.onEnd), {
      signal: pending.signal,
    });
    start.target.addEventListener("touchcancel", () => stopPending(props.onCancel), {
      signal: pending.signal,
    });
  }
}

type FolderEdit =
  | { readonly kind: "create" }
  | { readonly kind: "rename" | "delete"; readonly folder: ThreadFolder };

type Actions = {
  readonly onCreate: (name: string) => Promise<ThreadFolder | null>;
  readonly onRename: (folderId: string, name: string) => Promise<boolean>;
  readonly onDelete: (folderId: string) => Promise<boolean>;
};

type FolderMenuAction = "rename" | "delete" | "move-left" | "move-right";
type MenuPosition = { readonly x: number; readonly y: number };
type OpenContextMenu = (position: MenuPosition, source: ContextMenuSource) => Promise<void>;

export function SidebarThreadFolders(
  props: Actions & {
    readonly folders: readonly ThreadFolder[];
    readonly selectedFolderId: string | null;
    readonly showAll: boolean;
    readonly canManage: boolean;
    readonly canReorder: boolean;
    readonly onSelect: (folderId: string | null) => void;
    readonly onSelectAllMode: (showAll: boolean) => void;
    readonly onReorder: (folderId: string, beforeFolderId: string | null) => Promise<boolean>;
  },
) {
  const [edit, setEdit] = useState<FolderEdit | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: { x: 6 } } }),
    useSensor(FolderTouchSensor),
  );
  const { selectedFolderId } = props;
  const canReorder = props.canManage && props.canReorder && props.folders.length > 1;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- wheel must be registered as non-passive to translate scroll only while the strip can move
  useEffect(() => {
    const group = groupRef.current;
    const strip = stripRef.current;
    if (!group || !strip) return;

    const scrollFolders = (event: WheelEvent) => {
      if (!event.cancelable || event.ctrlKey || event.deltaX !== 0 || event.deltaY === 0) return;
      const { deltaMode, deltaY } = event;
      let delta = deltaY;
      if (deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= strip.clientWidth;
      const previousScrollLeft = strip.scrollLeft;
      strip.scrollLeft += delta;
      if (strip.scrollLeft !== previousScrollLeft) event.preventDefault();
    };

    group.addEventListener("wheel", scrollFolders, { passive: false });
    return () => group.removeEventListener("wheel", scrollFolders);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals the restored or newly selected tab in the horizontal strip
  useEffect(() => {
    if (selectedFolderId === null) return;
    const strip = stripRef.current;
    const selected = strip?.querySelector(
      `[data-thread-folder-id="${CSS.escape(selectedFolderId)}"]`,
    );
    if (!strip || !selected) return;
    const viewport = strip.getBoundingClientRect();
    const tab = selected.getBoundingClientRect();
    if (tab.right > viewport.right) strip.scrollLeft += tab.right - viewport.right;
    else if (tab.left < viewport.left) strip.scrollLeft += tab.left - viewport.left;
  }, [selectedFolderId]);

  const reorder = useStableCallback((folderId: string, targetIndex: number) => {
    const fromIndex = props.folders.findIndex(({ id }) => id === folderId);
    if (!canReorder || fromIndex < 0 || fromIndex === targetIndex || !props.folders[targetIndex]) {
      return;
    }
    const order = arrayMove([...props.folders], fromIndex, targetIndex);
    void props.onReorder(folderId, order[targetIndex + 1]?.id ?? null);
  });

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    draggingRef.current = false;
    if (!over) return;
    reorder(
      String(active.id),
      props.folders.findIndex(({ id }) => id === over.id),
    );
  };

  const applyFolderMenuAction = useStableCallback(
    (folderId: string, action: FolderMenuAction | null) => {
      if (!groupRef.current || !props.canManage) return;
      const index = props.folders.findIndex(({ id }) => id === folderId);
      const folder = props.folders[index];
      if (!folder) return;
      switch (action) {
        case "rename":
        case "delete":
          setEdit({ kind: action, folder });
          break;
        case "move-left":
          reorder(folderId, index - 1);
          break;
        case "move-right":
          reorder(folderId, index + 1);
          break;
      }
    },
  );

  const openAllMenu: OpenContextMenu = async (position, source) => {
    const action = await readLocalApi()
      ?.contextMenu.show(
        [
          { id: "all", label: "Show all threads", radio: true, checked: props.showAll },
          { id: "unfiled", label: "Show unfiled threads", radio: true, checked: !props.showAll },
        ],
        position,
        source,
      )
      .catch(() => null);
    if (groupRef.current && action) props.onSelectAllMode(action === "all");
  };

  return (
    <>
      <div
        ref={groupRef}
        role="group"
        aria-label="Thread folders"
        className="flex min-h-9 min-w-0 items-center gap-1"
      >
        <FolderFilterButton
          data-thread-folder-all
          aria-pressed={selectedFolderId === null}
          onSelect={() => props.onSelect(null)}
          onOpenMenu={openAllMenu}
          isDragging={() => draggingRef.current}
        >
          <FolderIcon aria-hidden className="size-3.5 shrink-0" />
          All
        </FolderFilterButton>
        <div
          ref={stripRef}
          className="sidebar-thread-folders-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain py-1"
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={DRAG_MODIFIERS}
            autoScroll={{
              canScroll: (element) => element === stripRef.current,
              threshold: { x: 0.15, y: 0 },
              acceleration: 3,
            }}
            onDragStart={() => {
              draggingRef.current = true;
            }}
            onDragEnd={handleDragEnd}
            onDragCancel={() => {
              draggingRef.current = false;
            }}
          >
            <SortableContext
              items={props.folders.map(({ id }) => id)}
              strategy={horizontalListSortingStrategy}
            >
              {props.folders.map((folder, index) => (
                <FolderTab
                  key={folder.id}
                  folder={folder}
                  selected={selectedFolderId === folder.id}
                  canManage={props.canManage}
                  canReorder={canReorder}
                  canMoveLeft={index > 0}
                  canMoveRight={index < props.folders.length - 1}
                  isDragging={() => draggingRef.current}
                  onSelect={() => props.onSelect(folder.id)}
                  onMenuAction={(action) => applyFolderMenuAction(folder.id, action)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
        {props.canManage ? (
          <div className="mr-0.5 shrink-0 sm:mr-[3px]">
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
  readonly canReorder: boolean;
  readonly canMoveLeft: boolean;
  readonly canMoveRight: boolean;
  readonly isDragging: () => boolean;
  readonly onSelect: () => void;
  readonly onMenuAction: (action: FolderMenuAction | null) => void;
}) {
  const { folder } = props;
  const { isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: folder.id,
    disabled: !props.canReorder,
  });
  const color = PROJECT_ICON_COLORS.find(({ value }) => value === FOLDER_COLORS[folder.color]);
  const openFolderMenu: OpenContextMenu = async (position, source) => {
    const items: ContextMenuItem<FolderMenuAction>[] = [{ id: "rename", label: "Rename folder" }];
    if (props.canReorder) {
      items.push(
        { id: "move-left", label: "Move left", disabled: !props.canMoveLeft },
        { id: "move-right", label: "Move right", disabled: !props.canMoveRight },
      );
    }
    items.push({ id: "delete", label: "Delete folder", destructive: true });
    const action = await readLocalApi()
      ?.contextMenu.show(items, position, source)
      .catch(() => null);
    props.onMenuAction(action ?? null);
  };
  return (
    <FolderFilterButton
      registerNode={setNodeRef}
      style={{ transform: DndCss.Translate.toString(transform), transition }}
      className={isDragging ? "z-10 cursor-grabbing bg-sidebar-row-active" : undefined}
      data-thread-folder-id={folder.id}
      aria-pressed={props.selected}
      tooltip={folder.name}
      hideTooltip={isDragging}
      onSelect={props.onSelect}
      onOpenMenu={props.canManage ? openFolderMenu : undefined}
      isDragging={props.isDragging}
      onMouseDown={(event) => {
        if (event.button === 0 && !event.ctrlKey) listeners?.onMouseDown?.(event);
      }}
      onTouchStart={props.canReorder ? (event) => listeners?.onTouchStart?.(event) : undefined}
    >
      <FolderIcon aria-hidden className={cn("size-3.5 shrink-0", color?.className)} />
      <span className="truncate">{folder.name}</span>
    </FolderFilterButton>
  );
}

function FolderFilterButton({
  className,
  children,
  onSelect,
  onOpenMenu,
  isDragging,
  tooltip,
  hideTooltip,
  registerNode,
  ...buttonProps
}: Omit<ComponentPropsWithoutRef<"button">, "children" | "onSelect"> & {
  readonly children: ReactNode;
  readonly onSelect: () => void;
  readonly onOpenMenu?: OpenContextMenu | undefined;
  readonly isDragging: () => boolean;
  readonly tooltip?: string;
  readonly hideTooltip?: boolean;
  readonly registerNode?: (element: HTMLButtonElement | null) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [touchDragReady, setTouchDragReady] = useState(false);
  const menuOpenRef = useRef(false);
  const suppressPointerClick = useRef(false);
  const press = useRef<{ timer: number; pointerId: number; x: number; y: number } | null>(null);
  const canTouchDrag = buttonProps.onTouchStart !== undefined;

  const cancelPress = useStableCallback(() => {
    if (!press.current) return;
    window.clearTimeout(press.current.timer);
    press.current = null;
    setTouchDragReady(false);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the touch hold timer on unmount
  useEffect(() => cancelPress, [cancelPress]);

  const attachButton = (button: HTMLButtonElement | null) => {
    registerNode?.(button);
    if (!button) return;
    const onTouchEnd = (event: TouchEvent) => {
      // A completed hold must not generate a mouse event that refocuses the trigger.
      if (suppressPointerClick.current) event.preventDefault();
    };
    button.addEventListener("touchend", onTouchEnd, { passive: false });
    return () => {
      button.removeEventListener("touchend", onTouchEnd);
      registerNode?.(null);
    };
  };

  const openMenu = useStableCallback(
    async (button: HTMLButtonElement, position: MenuPosition, source: ContextMenuSource) => {
      if (!onOpenMenu || menuOpenRef.current) return;
      menuOpenRef.current = true;
      setMenuOpen(true);
      button.focus({ preventScroll: true });
      await onOpenMenu(position, source).finally(() => {
        menuOpenRef.current = false;
        setMenuOpen(false);
      });
    },
  );

  const button = (
    <button
      {...buttonProps}
      data-touch-drag-ready={touchDragReady || undefined}
      ref={attachButton}
      type="button"
      className={cn(tabClassName, touchDragReady && "bg-sidebar-row-active", className)}
      aria-haspopup={onOpenMenu ? "menu" : undefined}
      aria-expanded={onOpenMenu ? menuOpen : undefined}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          (event.detail !== 0 && (suppressPointerClick.current || event.ctrlKey))
        ) {
          event.preventDefault();
          return;
        }
        onSelect();
      }}
      onContextMenu={(event) => {
        if (!onOpenMenu) return;
        event.preventDefault();
        event.stopPropagation();
        if (
          press.current !== null ||
          suppressPointerClick.current ||
          isDragging() ||
          (event.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType === "touch")
        )
          return;
        suppressPointerClick.current = true;
        const source = contextMenuSourceOf(event);
        const rect = event.currentTarget.getBoundingClientRect();
        void openMenu(
          event.currentTarget,
          source === "keyboard"
            ? { x: rect.left, y: rect.bottom }
            : { x: event.clientX, y: event.clientY },
          source,
        );
      }}
      onKeyDown={(event) => {
        if (
          !onOpenMenu ||
          isDragging() ||
          (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        void openMenu(event.currentTarget, { x: rect.left, y: rect.bottom }, "keyboard");
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "touch" && !event.isPrimary) return;
        cancelPress();
        suppressPointerClick.current = false;
        if (!onOpenMenu || event.pointerType !== "touch") return;
        const { currentTarget, pointerId, clientX: x, clientY: y } = event;
        press.current = {
          pointerId,
          x,
          y,
          timer: window.setTimeout(() => {
            suppressPointerClick.current = true;
            if (canTouchDrag) {
              setTouchDragReady(true);
              return;
            }
            press.current = null;
            if (!isDragging()) void openMenu(currentTarget, { x, y }, "mouse");
          }, LONG_PRESS_MS),
        };
      }}
      onPointerMove={(event) => {
        const hold = press.current;
        if (
          hold?.pointerId === event.pointerId &&
          Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > TOUCH_MOVE_TOLERANCE
        )
          cancelPress();
      }}
      onPointerUp={(event) => {
        const hold = press.current;
        if (hold?.pointerId !== event.pointerId) return;
        cancelPress();
        // The same hold arms sorting. A release with no movement opens the menu instead.
        if (canTouchDrag && suppressPointerClick.current && !isDragging()) {
          void openMenu(event.currentTarget, { x: hold.x, y: hold.y }, "mouse");
        }
      }}
      onPointerCancel={cancelPress}
    >
      {children}
    </button>
  );

  if (!tooltip) return button;
  return (
    <Tooltip disabled={menuOpen || hideTooltip}>
      <TooltipTrigger render={button} />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
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
