import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";
import appCss from "../../index.css?inline";
import { SidebarThreadFolders } from "./SidebarThreadFolders";

const folders = Array.from({ length: 8 }, (_, index) => ({
  id: String(index),
  name: `Folder ${index + 1}`,
  color: index,
}));

function TestFolders(props: Partial<ComponentProps<typeof SidebarThreadFolders>>) {
  const [folder, selectFolder] = useState<string | null>(props.selectedFolderId ?? null);
  const [showAll, setShowAll] = useState(props.showAll ?? true);
  return (
    <SidebarThreadFolders
      folders={folders}
      canManage
      canReorder
      onReorder={async () => false}
      onCreate={async () => null}
      onRename={async () => false}
      onDelete={async () => false}
      {...props}
      selectedFolderId={folder}
      showAll={showAll}
      onSelect={(id) => {
        selectFolder(id);
        props.onSelect?.(id);
      }}
      onSelectAllMode={(mode) => {
        setShowAll(mode);
        selectFolder(null);
        props.onSelectAllMode?.(mode);
      }}
    />
  );
}

function viewportPoint(x: number, y: number) {
  const frame = window.frameElement?.getBoundingClientRect();
  return { x: x + (frame?.left ?? 0), y: y + (frame?.top ?? 0) };
}

async function renderFolders(props: Partial<ComponentProps<typeof SidebarThreadFolders>> = {}) {
  await using stack = new AsyncDisposableStack();
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  stack.defer(() => style.remove());

  const container = document.createElement("div");
  container.style.width = "210px";
  const screen = stack.use(
    await render(<TestFolders {...props} />, {
      container,
      // The standalone folder strip has no route dependencies.
      router: false,
    }),
  );
  const strip = container.querySelector<HTMLDivElement>(".sidebar-thread-folders-scroll")!;
  const resources = stack.move();
  return {
    screen,
    strip,
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}

describe("sidebar thread folders", () => {
  it("reveals a restored folder and opens its actions from the keyboard", async () => {
    const onRename = vi.fn().mockResolvedValue(true);
    // The All mode is remembered independently of the active folder.
    await using mounted = await renderFolders({ selectedFolderId: "7", showAll: true, onRename });

    const selected = mounted.screen.getByRole("button", { name: "Folder 8", exact: true });
    await expect.element(selected).toHaveAttribute("aria-pressed", "true");
    expect(mounted.strip.scrollLeft).toBeGreaterThan(0);

    selected.element().focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await userEvent.click(page.getByRole("menuitem", { name: "Rename folder" }));
    const dialog = page.getByRole("dialog", { name: "Rename folder" });
    await dialog.getByRole("textbox", { name: "Folder name" }).fill("Renamed");
    await userEvent.click(dialog.getByRole("button", { name: "Save name" }));

    await expect.element(dialog).not.toBeInTheDocument();
    expect(onRename).toHaveBeenCalledExactlyOnceWith("7", "Renamed");
  });

  it("changes the remembered All mode through a right-click without selecting the tab", async () => {
    const onSelect = vi.fn();
    await using mounted = await renderFolders({ selectedFolderId: "0", onSelect });
    const all = mounted.screen.getByRole("button", { name: "All", exact: true });
    await userEvent.click(all, { button: "right" });
    const showAll = page.getByRole("menuitemradio", { name: "Show all threads" });
    const unfiled = page.getByRole("menuitemradio", { name: "Show unfiled threads" });
    await expect.element(showAll).toHaveAttribute("aria-checked", "true");
    await expect.element(unfiled).toHaveAttribute("aria-checked", "false");
    await expect.element(all).toHaveAttribute("aria-pressed", "false");
    expect(onSelect).not.toHaveBeenCalled();

    await userEvent.click(unfiled);
    await expect.element(all).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(mounted.screen.getByRole("button", { name: "Folder 1", exact: true }));
    await userEvent.click(all);
    expect(onSelect.mock.calls).toEqual([["0"], [null]]);
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect.element(unfiled).toHaveAttribute("aria-checked", "true");
    await expect.element(showAll).toHaveAttribute("aria-checked", "false");
    await userEvent.keyboard("{Escape}");
  });

  it("opens folder actions after releasing a touch hold without opening on movement", async () => {
    const onSelect = vi.fn();
    await using mounted = await renderFolders({ onSelect });
    const folder = mounted.screen.getByRole("button", { name: "Folder 1", exact: true }).element();
    const rect = folder.getBoundingClientRect();
    using _timers = fakeTimers();
    const dispatchTouch = (type: string, offset = 0) =>
      folder.dispatchEvent(
        new PointerEvent(type, {
          pointerType: "touch",
          pointerId: 1,
          isPrimary: true,
          clientX: rect.left + 5 + offset,
          clientY: rect.top + 5,
          bubbles: true,
        }),
      );

    await act(() => {
      dispatchTouch("pointerdown");
      dispatchTouch("pointermove", 15);
      vi.advanceTimersByTime(500);
      dispatchTouch("pointerup");
    });
    expect(document.querySelector("[data-context-menu]")).toBeNull();

    await act(() => {
      dispatchTouch("pointerdown");
      vi.advanceTimersByTime(500);
      dispatchTouch("pointermove", 15);
      dispatchTouch("pointerup");
    });
    expect(document.querySelector("[data-context-menu]")).toBeNull();

    await act(() => {
      dispatchTouch("pointerdown");
      vi.advanceTimersByTime(500);
    });
    expect(document.querySelector("[data-context-menu]")).toBeNull();
    await act(() => {
      dispatchTouch("pointerup");
      const release = new TouchEvent("touchend", { bubbles: true, cancelable: true });
      expect(folder.dispatchEvent(release)).toBe(false);
      folder.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    await expect.element(page.getByRole("menuitem", { name: "Rename folder" })).toBeVisible();
    expect(onSelect).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
  });

  it("only translates a vertical wheel when the strip can scroll in that direction", async () => {
    await using mounted = await renderFolders();
    const { strip } = mounted;
    const wheel = (init: WheelEventInit) =>
      strip.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }));

    expect(wheel({ deltaY: -20 })).toBe(true);
    expect(wheel({ deltaX: 4, deltaY: 20 })).toBe(true);
    expect(wheel({ deltaY: 20, ctrlKey: true })).toBe(true);
    expect(strip.scrollLeft).toBe(0);
    expect(wheel({ deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_LINE })).toBe(false);
    expect(strip.scrollLeft).toBe(16);
    strip.scrollLeft = strip.scrollWidth;
    expect(wheel({ deltaY: 20 })).toBe(true);
    expect(wheel({ deltaY: -20 })).toBe(false);
  });

  it("scrolls natively on a horizontal wheel gesture while All stays in place", async () => {
    await using mounted = await renderFolders();
    const rect = mounted.strip.getBoundingClientRect();
    const position = viewportPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const all = mounted.screen.getByRole("button", { name: "All", exact: true }).element();
    const allLeft = all.getBoundingClientRect().left;
    const wheel = (deltaX: number) =>
      cdp().send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        ...position,
        deltaX,
        deltaY: 0,
      });
    await wheel(64);
    await vi.waitFor(() => expect(mounted.strip.scrollLeft).toBeGreaterThan(0));
    expect(all.getBoundingClientRect().left).toBe(allLeft);
    await wheel(-128);
    await vi.waitFor(() => expect(mounted.strip.scrollLeft).toBe(0));
  });

  it.each([
    { gesture: "right", button: "right", buttons: 2, modifiers: 0 },
    { gesture: "middle", button: "middle", buttons: 4, modifiers: 0 },
    { gesture: "Ctrl+left", button: "left", buttons: 1, modifiers: 2 },
  ] as const)("does not drag or select with a $gesture mouse gesture", async (gesture) => {
    const onReorder = vi.fn().mockResolvedValue(true);
    const onSelect = vi.fn();
    await using mounted = await renderFolders({
      folders: [
        { id: "a", name: "A", color: 0 },
        { id: "b", name: "B", color: 1 },
      ],
      onReorder,
      onSelect,
    });
    const center = (name: string) => {
      const rect = mounted.screen
        .getByRole("button", { name, exact: true })
        .element()
        .getBoundingClientRect();
      return viewportPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    };
    const start = center("A");
    const end = center("B");
    const mouse = (type: "mousePressed" | "mouseMoved" | "mouseReleased", point: typeof start) =>
      cdp().send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: gesture.button,
        buttons: type === "mouseReleased" ? 0 : gesture.buttons,
        modifiers: gesture.modifiers,
        clickCount: 1,
      });
    await mouse("mousePressed", start);
    try {
      await mouse("mouseMoved", { ...start, x: start.x + 10 });
      await mouse("mouseMoved", end);
    } finally {
      await mouse("mouseReleased", end);
    }
    expect(onReorder).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
  });

  it("autoscrolls during a mouse drag to the end without selecting a folder", async () => {
    const onReorder = vi.fn().mockResolvedValue(true);
    const onSelect = vi.fn();
    await using mounted = await renderFolders({ onReorder, onSelect });
    const first = mounted.screen.getByRole("button", { name: "Folder 1", exact: true });
    const all = mounted.screen.getByRole("button", { name: "All", exact: true });
    const allLeft = all.element().getBoundingClientRect().left;
    await userEvent.click(first);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("0");

    const start = first.element().getBoundingClientRect();
    const stripRight = mounted.strip.getBoundingClientRect().right;
    const scrollLimit = mounted.strip.scrollWidth - mounted.strip.clientWidth;
    const y = start.top + start.height / 2;
    const connection = cdp();
    const mouse = (type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number) =>
      connection.send("Input.dispatchMouseEvent", {
        type,
        ...viewportPoint(x, y),
        button: "left",
        buttons: type === "mouseReleased" ? 0 : 1,
        clickCount: 1,
      });

    await mouse("mousePressed", start.left + start.width / 2);
    try {
      await mouse("mouseMoved", stripRight - 2);
      await mouse("mouseMoved", stripRight - 1);
      await vi.waitFor(
        () => expect(mounted.strip.scrollLeft).toBeGreaterThanOrEqual(scrollLimit - 1),
        { timeout: 5_000 },
      );
    } finally {
      await mouse("mouseReleased", stripRight - 1);
    }
    await vi.waitFor(() => expect(onReorder).toHaveBeenCalledExactlyOnceWith("0", null));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(all.element().getBoundingClientRect().left).toBe(allLeft);
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  });
});
