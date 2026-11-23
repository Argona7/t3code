import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { chromium, type Locator, type Page } from "playwright-core";

import { readPairingPath, runPromise, test, WEB } from "./t3.ts";

function folderOrder() {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-thread-folder-all], [data-thread-folder-id]"),
    (tab) => ({ id: tab.dataset.threadFolderId ?? null, name: tab.textContent?.trim() }),
  );
}

function folderStripGeometry() {
  const group = document.querySelector('[role="group"][aria-label="Thread folders"]');
  const all = group?.querySelector("[data-thread-folder-all] svg");
  const plus = group?.querySelector('[aria-label="Add thread folder"] svg');
  const search = group?.closest('[data-sidebar="group"]')?.querySelector(".lucide-search");
  const row = document.querySelector("[data-sidebar-row] [data-slot='project-monogram']");
  if (!group || !all || !plus || !search || !row) throw new Error("Sidebar icons are missing");

  const bounds = group.getBoundingClientRect();
  return {
    all: all.getBoundingClientRect().left,
    search: search.getBoundingClientRect().left,
    row: row.getBoundingClientRect().left,
    startInset: all.getBoundingClientRect().left - bounds.left,
    endInset: bounds.right - plus.getBoundingClientRect().right,
  };
}

function folderStripScroll() {
  const strip = document.querySelector<HTMLElement>(".sidebar-thread-folders-scroll");
  if (!strip) throw new Error("Thread folder scroll viewport is missing");
  const bounds = strip.getBoundingClientRect();
  return {
    x: bounds.left + bounds.width / 2,
    y: bounds.top + bounds.height / 2,
    left: bounds.left,
    position: strip.scrollLeft,
    range: strip.scrollWidth - strip.clientWidth,
    scrollbarHeight: strip.offsetHeight - strip.clientHeight,
    scrollbarWidth: getComputedStyle(strip).scrollbarWidth,
  };
}

type TouchPoint = { x: number; y: number };

async function whileTouching(
  page: Page,
  from: TouchPoint,
  gesture: (move: (point: TouchPoint) => Promise<unknown>) => Promise<void>,
) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [from],
    });
    await gesture((point) =>
      cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] }),
    );
  } finally {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  }
}

async function folderCenter(folder: Locator) {
  await folder.scrollIntoViewIfNeeded();
  const bounds = await folder.boundingBox();
  if (!bounds) throw new Error("Folder is outside the viewport");
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

async function holdFolder(page: Page, folder: Locator, menuItem: Locator, sortable = false) {
  const ready = sortable ? folder.and(page.locator("[data-touch-drag-ready]")) : menuItem;
  await whileTouching(page, await folderCenter(folder), () =>
    ready.waitFor({ state: "visible", timeout: 5_000 }),
  );
  await menuItem.waitFor({ state: "visible", timeout: 5_000 });
}

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
    await browser.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await t3.open(unfiled);

    const filedTitle = /^Fix retry behavior(?:,|$)/;
    const unfiledTitle = /^Review changelog(?:,|$)/;
    const filedRow = screen.getByRole("button", filedTitle);
    const unfiledRow = screen.getByRole("button", unfiledTitle);
    const folders = screen.getByRole("group", "Thread folders");
    const mainFolder = folders.getByRole("button", "All", { exact: true });
    const release = folders.getByRole("button", "Release", { exact: true });
    const ops = folders.getByRole("button", "Ops", { exact: true });
    const showAll = screen.getByRole("menuitemradio", "Show all threads");
    const showUnfiled = screen.getByRole("menuitemradio", "Show unfiled threads");

    const createFolder = async (name: string) => {
      await folders.getByRole("button", "Add thread folder").tap();
      const create = screen.getByRole("dialog", "Create thread folder");
      await create.getByRole("textbox", "Folder name").fill(name);
      await create.getByRole("button", "Create folder").tap();
      await expect(folders.getByRole("button", name, { exact: true })).toBeVisible();
    };

    // A separate browser has its own session and local folder settings.
    const touchBrowser = await chromium.launch();
    try {
      const touchContext = await touchBrowser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: "dark",
        reducedMotion: "reduce",
        isMobile: true,
        hasTouch: true,
      });
      const touch = await touchContext.newPage();
      const pairingPath = await runPromise(readPairingPath);
      await touch.goto(new URL(pairingPath, app.baseUrl).href);
      await touch.waitForURL((url) => url.pathname !== "/pair", { timeout: 60_000 });
      await touch.goto(await browser.url());
      const toggle = touch.getByRole("button", { name: "Toggle main sidebar" });
      await toggle.tap();

      const touchFolders = touch.getByRole("group", { name: "Thread folders" });
      const touchMain = touchFolders.getByRole("button", { name: "All", exact: true });
      const touchRelease = touchFolders.getByRole("button", { name: "Release", exact: true });
      const touchFiledRow = touch.getByRole("button", { name: filedTitle });
      const touchUnfiledRow = touch.getByRole("button", { name: unfiledTitle });
      await touchFiledRow.waitFor({ state: "visible" });

      await createFolder("Release");
      await touchRelease.tap();
      await touchFiledRow.waitFor({ state: "hidden" });

      await mainFolder.tap();
      await screen.getByRole("button", "Move Fix retry behavior to a folder").tap();
      await screen.getByRole("menuitemradio", "Release").tap();
      await expect(filedRow).not.toBeVisible();
      await expect(unfiledRow).toBeVisible();
      await touchFiledRow.waitFor({ state: "visible" });
      await touchUnfiledRow.waitFor({ state: "hidden" });

      await mainFolder.secondaryTap();
      await expect(showUnfiled).toHaveAttribute("aria-checked", "true");
      await expect(showAll).toHaveAttribute("aria-checked", "false");
      await showAll.tap();
      await expect(filedRow).toBeVisible();
      await expect(unfiledRow).toBeVisible();
      await release.tap();
      await expect(filedRow).toBeVisible();
      await expect(unfiledRow).not.toBeVisible();
      await mainFolder.tap();
      await expect(filedRow).toBeVisible();
      await expect(unfiledRow).toBeVisible();

      await browser.reload();
      await expect(filedRow).toBeVisible();
      await expect(unfiledRow).toBeVisible();
      await mainFolder.secondaryTap();
      await expect(showAll).toHaveAttribute("aria-checked", "true");
      await expect(showUnfiled).toHaveAttribute("aria-checked", "false");
      await browser.keyboard.press("Escape");

      const touchShowUnfiled = touch.getByRole("menuitemradio", { name: "Show unfiled threads" });
      const touchShowAll = touch.getByRole("menuitemradio", { name: "Show all threads" });
      await holdFolder(touch, touchMain, touchShowUnfiled);
      expect(await touchShowUnfiled.getAttribute("aria-checked")).toBe("true");
      expect(await touchShowAll.getAttribute("aria-checked")).toBe("false");
      expect(await touchRelease.getAttribute("aria-pressed")).toBe("true");
      await touchShowAll.tap();
      await touchFiledRow.waitFor({ state: "visible" });
      await touchUnfiledRow.waitFor({ state: "visible" });
      await holdFolder(touch, touchMain, touchShowUnfiled);
      await touchShowUnfiled.tap();
      await touchFiledRow.waitFor({ state: "hidden" });
      await touchUnfiledRow.waitFor({ state: "visible" });
      await expect(filedRow).toBeVisible();
      await touchRelease.tap();

      await createFolder("Ops");
      await release.tap();
      await expect(folders.getByRole("button", /^Folder actions for /)).toHaveCount(0);
      expect(await touchFolders.getByRole("button", { name: /^Folder actions for / }).count()).toBe(
        0,
      );

      const [allFolder, releaseFolder, opsFolder] = await browser.evaluate(folderOrder);
      expect(allFolder).toEqual({ id: null, name: "All" });
      expect(releaseFolder?.name).toBe("Release");
      expect(opsFolder?.name).toBe("Ops");
      expect(releaseFolder?.id).toBeTruthy();
      expect(opsFolder?.id).toBeTruthy();
      await expect
        .poll(() => touch.evaluate(folderOrder))
        .toEqual([allFolder, releaseFolder, opsFolder]);

      const from = await ops.boundingBox();
      const to = await release.boundingBox();
      if (!from || !to) throw new Error("Both folders must be visible to reorder them");
      const y = from.y + from.height / 2;
      await browser.mouse.move(from.x + from.width / 2, y);
      await browser.mouse.down();
      await browser.mouse.move(from.x + from.width / 2 - 10, y);
      await browser.mouse.move(to.x + to.width / 4, y);
      await browser.mouse.up();

      await expect
        .poll(() => browser.evaluate(folderOrder))
        .toEqual([allFolder, opsFolder, releaseFolder]);
      await expect
        .poll(() => touch.evaluate(folderOrder))
        .toEqual([allFolder, opsFolder, releaseFolder]);
      await expect(release).toHaveAttribute("aria-pressed", "true");
      expect(await touchRelease.getAttribute("aria-pressed")).toBe("true");
      await expect(filedRow).toBeVisible();

      const touchOps = touchFolders.getByRole("button", { name: "Ops", exact: true });
      const touchFrom = await folderCenter(touchRelease);
      const touchTo = await folderCenter(touchOps);
      await whileTouching(touch, touchFrom, async (move) => {
        await touchRelease
          .and(touch.locator("[data-touch-drag-ready]"))
          .waitFor({ state: "visible" });
        await move({ x: touchFrom.x - 12, y: touchFrom.y });
        await move(touchTo);
      });
      await expect
        .poll(() => touch.evaluate(folderOrder))
        .toEqual([allFolder, releaseFolder, opsFolder]);
      await expect
        .poll(() => browser.evaluate(folderOrder))
        .toEqual([allFolder, releaseFolder, opsFolder]);
      expect(await touchRelease.getAttribute("aria-pressed")).toBe("true");
      expect(await touch.getByRole("menu").count()).toBe(0);

      const renameItem = touch.getByRole("menuitem", { name: "Rename folder" });
      await holdFolder(touch, touchRelease, renameItem, true);
      await renameItem.tap();
      const rename = touch.getByRole("dialog", { name: "Rename folder" });
      await rename.getByRole("textbox", { name: "Folder name" }).fill("Launch");
      await rename.getByRole("button", { name: "Save name" }).tap();
      const launch = folders.getByRole("button", "Launch", { exact: true });
      await expect(launch).toBeVisible();
      await expect(release).not.toBeVisible();
      await expect(filedRow).toBeVisible();
      const touchLaunch = touchFolders.getByRole("button", { name: "Launch", exact: true });
      await touchLaunch.waitFor({ state: "visible" });
      await touchFiledRow.waitFor({ state: "visible" });
      const renamedOrder = [allFolder, { ...releaseFolder, name: "Launch" }, opsFolder];
      expect(await browser.evaluate(folderOrder)).toEqual(renamedOrder);
      expect(await touch.evaluate(folderOrder)).toEqual(renamedOrder);

      await mainFolder.tap();
      await expect(filedRow).toBeVisible();
      await expect(unfiledRow).toBeVisible();
      await filedRow.tap();
      await expect(screen.getByRole("heading", "Fix retry behavior")).toBeVisible();
      await screen.getByRole("button", "Toggle thread details panel", { pressed: true }).tap();
      await browser.mouse.move(450, 320);
      const desktopGeometry = await browser.evaluate(folderStripGeometry);
      const touchGeometry = await touch.evaluate(folderStripGeometry);
      for (const geometry of [desktopGeometry, touchGeometry]) {
        expect(Math.abs(geometry.all - geometry.search)).toBeLessThanOrEqual(2);
        expect(Math.abs(geometry.all - geometry.row)).toBeLessThanOrEqual(2);
        expect(Math.abs(geometry.startInset - geometry.endInset)).toBeLessThanOrEqual(2);
      }
      await runPromise(
        Effect.log("Thread folder icon positions", {
          desktop: desktopGeometry,
          touch: touchGeometry,
        }),
      );
      const desktopCapture = await app.screenshot("thread-folder-strip-desktop");
      const touchCapture = await runPromise(
        Effect.map(Path.Path, (path) =>
          path.join(path.dirname(desktopCapture), "thread-folder-strip-touch.png"),
        ),
      );
      await touch.screenshot({ path: touchCapture, animations: "disabled" });

      await createFolder("Infrastructure");
      await createFolder("Design reviews");
      await mainFolder.tap();
      const strip = await browser.evaluate(folderStripScroll);
      expect(strip.range).toBeGreaterThan(0);
      expect(strip.scrollbarHeight).toBe(0);
      expect(strip.scrollbarWidth).toBe("none");
      const wheelDelta = strip.range + 1;
      await browser.mouse.move(strip.x, strip.y);
      await browser.mouse.wheel(0, -wheelDelta);
      await expect.poll(async () => (await browser.evaluate(folderStripScroll)).position).toBe(0);
      await browser.mouse.wheel(0, wheelDelta);
      await expect
        .poll(async () => (await browser.evaluate(folderStripScroll)).position)
        .toBe(strip.range);
      await browser.mouse.wheel(0, -wheelDelta);
      await expect.poll(async () => (await browser.evaluate(folderStripScroll)).position).toBe(0);

      await touchFolders.getByRole("button", { name: "Design reviews", exact: true }).waitFor({
        state: "visible",
      });
      const touchStrip = await touch.evaluate(folderStripScroll);
      expect(touchStrip.range).toBeGreaterThan(0);
      const swipeFrom = await folderCenter(touchOps);
      const touchOrder = await touch.evaluate(folderOrder);
      await whileTouching(touch, swipeFrom, async (move) => {
        const distance = swipeFrom.x - touchStrip.left + 10;
        for (const fraction of [0.25, 0.5, 0.75, 1]) {
          await move({ x: swipeFrom.x - distance * fraction, y: swipeFrom.y });
        }
      });
      await expect
        .poll(async () => (await touch.evaluate(folderStripScroll)).position)
        .toBeGreaterThan(0);
      expect(await touch.evaluate(folderOrder)).toEqual(touchOrder);
      expect(await touchLaunch.getAttribute("aria-pressed")).toBe("true");
      expect(await touch.getByRole("menu").count()).toBe(0);

      await launch.secondaryTap();
      await expect(mainFolder).toHaveAttribute("aria-pressed", "true");
      await screen.getByRole("menuitem", "Delete folder").tap();
      const remove = screen.getByRole("dialog", "Delete folder");
      await remove.getByRole("button", "Delete folder").tap();
      await touchLaunch.waitFor({ state: "hidden" });
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
