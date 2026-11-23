import { assert, it } from "@effect/vitest";
import { ContextMenuItemSchema } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import * as ElectronMenu from "./ElectronMenu.ts";

const { buildFromTemplate } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((_items: Electron.MenuItemConstructorOptions[]) => ({
    popup: (options: Electron.PopupOptions) => options.callback?.(),
  })),
}));

vi.mock("electron", () => ({ Menu: { buildFromTemplate } }));
const decodeMenuItems = Schema.decodeUnknownSync(Schema.Array(ContextMenuItemSchema));

it.effect("keeps radio choices mutually exclusive and ordinary checkboxes independent", () =>
  Effect.gen(function* () {
    buildFromTemplate.mockClear();
    const menu = yield* ElectronMenu.make;
    const items = decodeMenuItems([
      { id: "all", label: "All", radio: true, checked: false },
      { id: "unfiled", label: "Unfiled", radio: true, checked: true },
      { id: "pinned", label: "Pinned", checked: true, separatorBefore: true },
    ]);
    yield* menu.showContextMenu({
      window: { webContents: { getZoomFactor: () => 1 } } as Electron.BrowserWindow,
      items,
      position: Option.none(),
      source: Option.some("keyboard"),
    });
    assert.deepEqual(
      buildFromTemplate.mock.calls[0]?.[0].map(({ type, checked }) => [type, checked]),
      [
        ["radio", false],
        ["radio", true],
        ["separator", undefined],
        ["checkbox", true],
      ],
    );
  }).pipe(Effect.provideService(HostProcess.Platform, "darwin")),
);
