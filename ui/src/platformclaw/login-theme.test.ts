import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentGatewaySelectionKeyForPage,
  settingsKeyForGateway,
} from "../app/settings-storage.ts";
import { loadSettings, saveSettings } from "../app/settings.ts";
import { createImportedCustomThemeFixture } from "../test-helpers/custom-theme.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { installPlatformClawLoginTheme } from "./login-theme.ts";

const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const appGateway = `${protocol}//${window.location.host}/platformclaw/app`;
let dispose: (() => void) | undefined;
let prefersLight: boolean;
let system: EventTarget;

function persistTheme(
  theme: "platformclaw" | "claw" | "knot" | "dash",
  themeMode: "light" | "dark" | "system",
) {
  // Preserve the original order: app writes preferences, then navigates to login.
  window.history.replaceState({}, "", "/platformclaw/app/chat");
  saveSettings({ ...loadSettings(), theme, themeMode });
  window.history.replaceState({}, "", "/platformclaw/login");
}

function start() {
  dispose = installPlatformClawLoginTheme();
}

describe("login appearance preferences", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/platformclaw/app/chat");
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    prefersLight = true;
    system = new EventTarget();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        get matches() {
          return prefersLight;
        },
        addEventListener: system.addEventListener.bind(system),
        removeEventListener: system.removeEventListener.bind(system),
      })),
    );
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.getElementById("openclaw-custom-theme")?.remove();
    for (const attribute of ["data-theme", "data-theme-mode", "data-theme-resolved", "style"]) {
      document.documentElement.removeAttribute(attribute);
    }
    vi.unstubAllGlobals();
  });

  it.each([
    ["platformclaw", "dark", "platformclaw"],
    ["platformclaw", "light", "platformclaw-light"],
    ["claw", "dark", "dark"],
    ["knot", "dark", "openknot"],
    ["knot", "light", "openknot-light"],
    ["dash", "light", "dash-light"],
    ["dash", "dark", "dash"],
  ] as const)("keeps saved %s/%s when the OS disagrees", (theme, mode, resolved) => {
    prefersLight = mode === "dark";
    persistTheme(theme, mode);
    start();
    expect(document.documentElement.dataset).toMatchObject({
      theme: resolved,
      themeMode: mode,
      themeResolved: mode,
    });
    expect(document.documentElement.style.colorScheme).toBe(mode);
  });

  it("uses the app's fresh light default even on a dark OS", () => {
    prefersLight = false;
    start();
    expect(document.documentElement.dataset.theme).toBe("platformclaw-light");
  });

  it("uses the selected Gateway record, ignoring an earlier unrelated record", () => {
    const selected = "wss://selected.example/gateway";
    localStorage.setItem(
      settingsKeyForGateway("wss://unrelated.example"),
      JSON.stringify({
        theme: "claw",
        themeMode: "light",
      }),
    );
    localStorage.setItem(
      settingsKeyForGateway(selected),
      JSON.stringify({
        gatewayUrl: selected,
        theme: "dash",
        themeMode: "dark",
      }),
    );
    localStorage.setItem(currentGatewaySelectionKeyForPage(appGateway), selected);
    start();
    expect(document.documentElement.dataset.theme).toBe("dash");
  });

  it("tracks system preference and later browser settings changes", () => {
    persistTheme("knot", "system");
    start();
    expect(document.documentElement.dataset.theme).toBe("openknot-light");
    prefersLight = false;
    system.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.theme).toBe("openknot");
    persistTheme("dash", "light");
    window.dispatchEvent(new StorageEvent("storage"));
    expect(document.documentElement.dataset.theme).toBe("dash-light");
    prefersLight = false;
    system.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.theme).toBe("dash-light");
    dispose?.();
    persistTheme("claw", "dark");
    window.dispatchEvent(new StorageEvent("storage"));
    expect(document.documentElement.dataset.theme).toBe("dash-light");
  });

  it("restores validated custom theme tokens with the saved mode", () => {
    const customTheme = createImportedCustomThemeFixture();
    saveSettings({ ...loadSettings(), theme: "custom", themeMode: "dark", customTheme });
    window.history.replaceState({}, "", "/platformclaw/login");
    start();
    expect(document.documentElement.dataset.theme).toBe("custom");
    expect(document.getElementById("openclaw-custom-theme")?.textContent).toContain(
      `--bg: ${customTheme.dark.bg};`,
    );
    persistTheme("platformclaw", "light");
    window.dispatchEvent(new StorageEvent("storage"));
    expect(document.documentElement.dataset.theme).toBe("platformclaw-light");
  });

  it.each(["{", "null", "[]", '{"theme":"custom","themeMode":"dark"}'])(
    "keeps login usable with invalid stored appearance %s",
    (raw) => {
      localStorage.setItem(settingsKeyForGateway(appGateway), raw);
      start();
      expect(document.documentElement.dataset.theme).toMatch(/^platformclaw(?:-light)?$/);
    },
  );

  it("keeps the app default when browser storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new DOMException("Storage blocked", "SecurityError");
      },
      setItem() {},
    });
    start();
    expect(document.documentElement.dataset.theme).toBe("platformclaw-light");
  });
});
