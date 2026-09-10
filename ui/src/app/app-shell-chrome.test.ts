/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
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
