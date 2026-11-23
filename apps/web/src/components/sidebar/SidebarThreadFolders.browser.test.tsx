import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import appCss from "../../index.css?inline";
import { SidebarThreadFolders } from "./SidebarThreadFolders";

describe("sidebar thread folders", () => {
  it("reveals a restored folder and opens its actions from the keyboard", async () => {
    using cleanup = new DisposableStack();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    cleanup.defer(() => style.remove());

    const container = document.createElement("div");
    container.style.width = "210px";
    const onRename = vi.fn().mockResolvedValue(true);
    const folders = Array.from({ length: 8 }, (_, index) => ({
      id: String(index),
      name: `Folder ${index + 1}`,
      color: index,
    }));
    await using screen = await render(
      <SidebarThreadFolders
        folders={folders}
        selectedFolderId="7"
        showAll={false}
        canManage
        onSelect={() => {}}
        onCreate={async () => null}
        onRename={onRename}
        onDelete={async () => false}
      />,
      { container, router: false },
    );

    const selected = screen.getByRole("button", { name: "Folder 8", exact: true });
    await expect.element(selected).toHaveAttribute("aria-pressed", "true");
    const strip = container.querySelector(".sidebar-thread-folders-scroll")!;
    expect(strip.scrollLeft).toBeGreaterThan(0);

    (selected.element() as HTMLElement).focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await userEvent.click(page.getByRole("menuitem", { name: "Rename folder" }));
    const dialog = page.getByRole("dialog", { name: "Rename folder" });
    await dialog.getByRole("textbox", { name: "Folder name" }).fill("Renamed");
    await userEvent.click(dialog.getByRole("button", { name: "Save name" }));

    await expect.element(dialog).not.toBeInTheDocument();
    expect(onRename).toHaveBeenCalledExactlyOnceWith("7", "Renamed");
  });
});
