import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { resolveControlUiBasePath } from "./browser.ts";
import { currentGatewaySelectionKeyForPage, settingsKeyForGateway } from "./settings-storage.ts";
import { applyStoredTheme, applyThemePresentation } from "./theme-bootstrap.ts";

const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const pageGateway = `${protocol}//${window.location.host}/tenant`;

describe("stored theme bootstrap", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/tenant/chat");
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
  });

  afterEach(() => {
    for (const attribute of ["data-theme", "data-theme-mode", "data-theme-resolved", "style"]) {
      document.documentElement.removeAttribute(attribute);
    }
    document.documentElement.classList.remove("wa-light", "wa-dark");
    vi.unstubAllGlobals();
  });

  it("resolves the mounted app's selected record instead of the first stored key", () => {
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
        theme: "platformclaw",
        themeMode: "dark",
      }),
    );
    localStorage.setItem(currentGatewaySelectionKeyForPage(pageGateway), selected);
    applyStoredTheme(resolveControlUiBasePath(location.pathname));
    expect(document.documentElement.dataset).toMatchObject({
      theme: "platformclaw",
      themeMode: "dark",
      themeResolved: "dark",
    });
  });

  it("falls back to this mount's record if the selected record belongs to another Gateway", () => {
    const selected = "wss://selected.example/gateway";
    localStorage.setItem(currentGatewaySelectionKeyForPage(pageGateway), selected);
    localStorage.setItem(
      settingsKeyForGateway(selected),
      JSON.stringify({
        gatewayUrl: "wss://another.example/gateway",
        theme: "dash",
        themeMode: "light",
      }),
    );
    localStorage.setItem(
      settingsKeyForGateway(pageGateway),
      JSON.stringify({
        gatewayUrl: pageGateway,
        theme: "knot",
        themeMode: "dark",
      }),
    );
    applyStoredTheme(resolveControlUiBasePath(location.pathname));
    expect(document.documentElement.dataset.theme).toBe("openknot");
  });

  it("keeps fresh light defaults and the app's legacy mode parser consistent", () => {
    applyStoredTheme(resolveControlUiBasePath(location.pathname));
    expect(document.documentElement.dataset.theme).toBe("platformclaw-light");
    localStorage.setItem(settingsKeyForGateway(pageGateway), JSON.stringify({ theme: "dash" }));
    applyStoredTheme(resolveControlUiBasePath(location.pathname));
    expect(document.documentElement.dataset.theme).toBe("dash");
  });

  it("keeps first paint and live theme changes consistent for component themes and text scale", () => {
    const root = document.documentElement;
    applyStoredTheme(resolveControlUiBasePath(location.pathname));
    expect(root.classList.contains("wa-light")).toBe(true);
    expect(root.classList.contains("wa-dark")).toBe(false);

    applyThemePresentation({ theme: "dash", themeMode: "dark", textScale: 125 });
    expect(root.dataset).toMatchObject({ theme: "dash", themeMode: "dark", themeResolved: "dark" });
    expect(root.classList.contains("wa-light")).toBe(false);
    expect(root.classList.contains("wa-dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");
    expect(root.style.getPropertyValue("--control-ui-text-scale")).toBe("1.25");

    applyThemePresentation({ theme: "claw", themeMode: "light" });
    expect(root.classList.contains("wa-light")).toBe(true);
    expect(root.classList.contains("wa-dark")).toBe(false);
    expect(root.style.getPropertyValue("--control-ui-text-scale")).toBe("1");
  });
});
