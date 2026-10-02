/* @vitest-environment jsdom */

import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  COMMAND_PALETTE_TARGET_EVENT,
  type CommandPaletteTargetDetail,
} from "../components/command-palette-contract.ts";
import { hasOpenModalDialog, type OpenClawModalDialog } from "../components/modal-dialog.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { ShellChromeOwner, type ShellChromeHost } from "./app-shell-chrome.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("ShellChromeOwner settings Escape", () => {
  it("leaves settings open when Escape belongs to a shadow-backed modal", async () => {
    const exitSettings = vi.fn();
    const host = Object.assign(document.createElement("div"), {
      runtime: { settingsNavigationMode: "takeover" },
      routeState: { routeId: "appearance" },
      navDrawerOpen: false,
      onboardingMode: false,
      terminalPanelElement: { tagName: "test-terminal-panel" },
      exitSettings,
    }) as unknown as ShellChromeHost;
    const owner = new ShellChromeOwner(host);
    const modal = document.createElement("openclaw-modal-dialog") as OpenClawModalDialog;
    const restoreDialog = installDialogPolyfill();
    try {
      document.body.append(modal);
      await getRenderedModalDialog(document.body);
      expect(hasOpenModalDialog()).toBe(true);

      owner.handleDocumentKeydown(
        new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );

      expect(exitSettings).not.toHaveBeenCalled();
    } finally {
      modal.remove();
      restoreDialog();
    }
    expect(hasOpenModalDialog()).toBe(false);
  });

  it("exits settings when the page owns Escape", () => {
    const exitSettings = vi.fn();
    const host = Object.assign(document.createElement("div"), {
      runtime: { settingsNavigationMode: "takeover" },
      routeState: { routeId: "appearance" },
      navDrawerOpen: false,
      onboardingMode: false,
      terminalPanelElement: { tagName: "test-terminal-panel" },
      exitSettings,
    }) as unknown as ShellChromeHost;
    const owner = new ShellChromeOwner(host);
    owner.handleDocumentKeydown(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));

    expect(exitSettings).toHaveBeenCalledOnce();
  });
});

describe("ShellChromeOwner mounted chat target ownership", () => {
  it("clears a detached target through its registered release without a bubbling detach event", () => {
    const requestUpdate = vi.fn();
    const host = Object.assign(document.createElement("div"), {
      commandPaletteTarget: undefined,
      requestUpdate,
    }) as unknown as ShellChromeHost;
    const chrome = new ShellChromeOwner(host);
    const owner = document.createElement("section");
    host.append(owner);
    document.body.append(host);
    let release!: () => void;
    const detail: CommandPaletteTargetDetail = {
      owner,
      sessionKey: "agent:main:space-session:00000000-0000-4000-8000-000000000008",
      onSlashCommand: vi.fn(),
      registerRelease: (callback) => {
        release = callback;
      },
    };
    chrome.handleCommandPaletteTarget(new CustomEvent(COMMAND_PALETTE_TARGET_EVENT, { detail }));
    expect(host.commandPaletteTarget).toBe(detail);
    requestUpdate.mockClear();

    owner.remove();
    release();

    expect(owner.isConnected).toBe(false);
    expect(host.commandPaletteTarget).toBeUndefined();
    expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it("does not let an old release clear a newer session declaration from the same pane", () => {
    const requestUpdate = vi.fn();
    const host = Object.assign(document.createElement("div"), {
      commandPaletteTarget: undefined,
      requestUpdate,
    }) as unknown as ShellChromeHost;
    const chrome = new ShellChromeOwner(host);
    const owner = document.createElement("section");
    const releases: Array<() => void> = [];
    const declare = (sessionKey: string) => {
      const detail: CommandPaletteTargetDetail = {
        owner,
        sessionKey,
        onSlashCommand: vi.fn(),
        registerRelease: (release) => releases.push(release),
      };
      chrome.handleCommandPaletteTarget(new CustomEvent(COMMAND_PALETTE_TARGET_EVENT, { detail }));
      return detail;
    };
    declare("agent:main:first");
    const current = declare("agent:main:second");
    requestUpdate.mockClear();

    const firstRelease = releases[0];
    const secondRelease = releases[1];
    assert.isDefined(firstRelease);
    assert.isDefined(secondRelease);
    firstRelease();

    expect(host.commandPaletteTarget).toBe(current);
    expect(requestUpdate).not.toHaveBeenCalled();
    secondRelease();
    expect(host.commandPaletteTarget).toBeUndefined();
    expect(requestUpdate).toHaveBeenCalledOnce();
  });
});
