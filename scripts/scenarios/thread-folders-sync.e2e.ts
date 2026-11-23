import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { chromium } from "playwright-core";

import { readPairingPath, runPromise, test, WEB } from "./t3.ts";

test(
  "Thread folders sync between desktop and touch web clients",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const unfiled = await t3.thread({
      project,
      title: "Review changelog",
      messages: ["Check release notes"],
    });
    await t3.thread({
      project,
      title: "Fix retry behavior",
      messages: ["Investigate retries"],
    });
    await t3.open(unfiled);

    const filedTitle = /^Fix retry behavior(?:,|$)/;
    const unfiledTitle = /^Review changelog(?:,|$)/;
    const filedRow = screen.getByRole("button", filedTitle);
    const unfiledRow = screen.getByRole("button", unfiledTitle);
    const folders = screen.getByRole("group", "Thread folders");
    const mainFolder = folders.getByRole("button", "All");
    const folder = folders.getByRole("button", "Release");

    // A separate browser has its own session and local folder selection.
    const touchBrowser = await chromium.launch();
    try {
      const touchContext = await touchBrowser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      const touch = await touchContext.newPage();
      const pairingPath = await runPromise(readPairingPath);
      await touch.goto(new URL(pairingPath, app.baseUrl).href);
      await touch.waitForURL((url) => url.pathname !== "/pair", { timeout: 60_000 });
      await touch.goto(await browser.url());
      await touch.getByRole("button", { name: "Toggle main sidebar" }).tap();

      const touchFolders = touch.getByRole("group", { name: "Thread folders" });
      const touchFolder = touchFolders.getByRole("button", { name: "Release", exact: true });
      const touchFiledRow = touch.getByRole("button", { name: filedTitle });
      const touchUnfiledRow = touch.getByRole("button", { name: unfiledTitle });
      await touchFiledRow.waitFor({ state: "visible" });
      await touchFolders.getByRole("button", { name: "All", exact: true }).waitFor({
        state: "visible",
      });

      await folders.getByRole("button", "Add thread folder").tap();
      const create = screen.getByRole("dialog", "Create thread folder");
      await create.getByRole("textbox", "Folder name").fill("Release");
      await create.getByRole("button", "Create folder").tap();
      await touchFolder.tap();
      await touchFiledRow.waitFor({ state: "hidden" });

      await mainFolder.tap();
      await screen.getByRole("button", "Move Fix retry behavior to a folder").tap();
      await screen.getByRole("menuitemradio", "Release").tap();
      await expect(filedRow).not.toBeVisible();
      await expect(unfiledRow).toBeVisible();
      await touchFiledRow.waitFor({ state: "visible" });
      await touchUnfiledRow.waitFor({ state: "hidden" });

      await screen.getByRole("combobox", "Filter threads by project").tap();
      await screen.getByRole("option", "Show all threads").tap();
      await expect(filedRow).toBeVisible();
      await expect(unfiledRow).toBeVisible();
      await mainFolder.tap();
      await expect(filedRow).not.toBeVisible();
      await folder.tap();
      await expect(filedRow).toBeVisible();
      await expect(unfiledRow).not.toBeVisible();
      await filedRow.tap();
      await expect(screen.getByRole("heading", "Fix retry behavior")).toBeVisible();
      await screen.getByRole("button", "Toggle thread details panel", { pressed: true }).tap();
      const desktopCapture = await app.screenshot("thread-folder-desktop");

      await touchFolders.getByRole("button", { name: "Folder actions for Release" }).tap();
      const renameItem = touch.getByRole("menuitem", { name: "Rename folder" });
      await renameItem.waitFor({ state: "visible" });
      const touchCapture = await runPromise(
        Effect.map(Path.Path, (path) =>
          path.join(path.dirname(desktopCapture), "thread-folder-touch.png"),
        ),
      );
      await touch.screenshot({ path: touchCapture, animations: "disabled" });
      await renameItem.tap();
      const rename = touch.getByRole("dialog", { name: "Rename folder" });
      await rename.getByRole("textbox", { name: "Folder name" }).fill("Launch");
      await rename.getByRole("button", { name: "Save name" }).tap();
      await expect(folders.getByRole("button", "Launch")).toBeVisible();
      await expect(folder).not.toBeVisible();
      await expect(filedRow).toBeVisible();
      const renamedTouchFolder = touchFolders.getByRole("button", { name: "Launch", exact: true });
      await renamedTouchFolder.waitFor({ state: "visible" });

      await folders.getByRole("button", "Folder actions for Launch").tap();
      await screen.getByRole("menuitem", "Delete folder").tap();
      const remove = screen.getByRole("dialog", "Delete folder");
      await remove.getByRole("button", "Delete folder").tap();
      await renamedTouchFolder.waitFor({ state: "hidden" });
      await touchFolders.getByRole("button", { name: "All", exact: true, pressed: true }).waitFor({
        state: "visible",
      });
      await touchUnfiledRow.waitFor({ state: "visible" });
      await touchFiledRow.waitFor({ state: "visible" });
      await expect(mainFolder).toHaveAttribute("aria-pressed", "true");
      await expect(filedRow).toBeVisible();
      await expect(unfiledRow).toBeVisible();
    } finally {
      await touchBrowser.close();
    }
  },
);
