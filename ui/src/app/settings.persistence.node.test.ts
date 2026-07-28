// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { loadLocalUserIdentity, loadSettings, saveSettings, type UiSettings } from "./settings.ts";

function setTestLocation(params: { protocol: string; host: string; pathname: string }) {
  vi.stubGlobal("location", {
    protocol: params.protocol,
    host: params.host,
    hostname: params.host.replace(/:\d+$/, ""),
    pathname: params.pathname,
  } as Location);
}

function setControlUiBasePath(value: string | undefined) {
  type TestWindow = Window & typeof globalThis & { [key: string]: unknown };
  if (typeof window === "undefined") {
    vi.stubGlobal(
      "window",
      value == null
        ? ({} as TestWindow)
        : ({ __OPENCLAW_CONTROL_UI_BASE_PATH__: value } as unknown as TestWindow),
    );
    return;
  }
  if (value == null) {
    delete (window as TestWindow)["__OPENCLAW_CONTROL_UI_BASE_PATH__"];
    return;
  }
  Object.defineProperty(window, "__OPENCLAW_CONTROL_UI_BASE_PATH__", {
    value,
    writable: true,
    configurable: true,
  });
}

function expectedGatewayUrl(basePath: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${basePath}`;
}

function makeSettings(gatewayUrl: string, overrides: Partial<UiSettings> = {}): UiSettings {
  return {
    gatewayUrl,
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    chatShowThinking: true,
    chatShowToolCalls: true,
    navCollapsed: false,
    navWidth: 258,
    sidebarEntries: [],
    ...overrides,
  };
}

describe("loadSettings scoped persistence", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    localStorage.clear();
    sessionStorage.clear();
    setControlUiBasePath(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestLocation({ protocol: "https:", host: "gateway.example", pathname: "/" });
    saveSettings(loadSettings());
    setControlUiBasePath(undefined);
    vi.unstubAllGlobals();
  });

  it("scopes persisted session selection per gateway", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway-a.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
    });

    const settings = loadSettings();
    expect(settings.gatewayUrl).toBe(gwUrl);
    expect(settings.sessionKey).toBe("agent:test_old:main");
    expect(settings.lastActiveSessionKey).toBe("agent:test_old:main");
  });

  it("caps persisted session scopes to the most recent gateways", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });

    const gwUrl = expectedGatewayUrl("");
    const scopedKey = `openclaw.control.settings.v1:wss://gateway.example:8443`;

    // Pre-seed sessionsByGateway with 11 stale gateway entries so the next
    // saveSettings call pushes the total to 12 and triggers the cap (10).
    const staleEntries: Record<string, { sessionKey: string; lastActiveSessionKey: string }> = {};
    for (let i = 0; i < 11; i += 1) {
      staleEntries[`wss://stale-${i}.example:8443`] = {
        sessionKey: `agent:stale_${i}:main`,
        lastActiveSessionKey: `agent:stale_${i}:main`,
      };
    }
    localStorage.setItem(scopedKey, JSON.stringify({ sessionsByGateway: staleEntries }));

    saveSettings({
      gatewayUrl: gwUrl,
      token: "",
      sessionKey: "agent:current:main",
      lastActiveSessionKey: "agent:current:main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      navCollapsed: false,
      navWidth: 258,
      sidebarEntries: [],
    });

    const persisted = JSON.parse(localStorage.getItem(scopedKey) ?? "{}");

    const scopedSessions = persisted.sessionsByGateway as Record<
      string,
      { sessionKey: string; lastActiveSessionKey: string }
    >;
    expect(scopedSessions["wss://gateway.example:8443"]).toEqual({
      sessionKey: "agent:current:main",
      lastActiveSessionKey: "agent:current:main",
    });
    expect(Object.keys(scopedSessions)).toEqual([
      "wss://stale-2.example:8443",
      "wss://stale-3.example:8443",
      "wss://stale-4.example:8443",
      "wss://stale-5.example:8443",
      "wss://stale-6.example:8443",
      "wss://stale-7.example:8443",
      "wss://stale-8.example:8443",
      "wss://stale-9.example:8443",
      "wss://stale-10.example:8443",
      "wss://gateway.example:8443",
    ]);
  });

  it("does not let a saved sibling base path override the current page gateway", () => {
    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-a/" });
    setControlUiBasePath("/gateway-a");
    saveSettings(makeSettings(expectedGatewayUrl("/gateway-a")));

    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-b/" });
    setControlUiBasePath("/gateway-b");

    expect(loadSettings().gatewayUrl).toBe(expectedGatewayUrl("/gateway-b"));
    expect(localStorage.getItem("openclaw.control.settings.v1")).toBeNull();
  });

  it("keeps custom gateway selections isolated per Control UI base path", () => {
    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-a/" });
    setControlUiBasePath("/gateway-a");
    saveSettings(makeSettings("wss://remote-a.example.com", { sessionKey: "agent:a:main" }));

    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-b/" });
    setControlUiBasePath("/gateway-b");
    saveSettings(makeSettings("wss://remote-b.example.com", { sessionKey: "agent:b:main" }));

    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-a/" });
    setControlUiBasePath("/gateway-a");
    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://remote-a.example.com",
      sessionKey: "agent:a:main",
    });

    setTestLocation({ protocol: "https:", host: "multi.example:8443", pathname: "/gateway-b/" });
    setControlUiBasePath("/gateway-b");
    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://remote-b.example.com",
      sessionKey: "agent:b:main",
    });
  });

  it("loads local user identity separately from gateway settings", () => {
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/",
    });
    localStorage.setItem(
      "openclaw.control.user.v1",
      JSON.stringify({ name: "Buns", avatar: "🦞" }),
    );

    expect(loadLocalUserIdentity()).toEqual({
      name: "Buns",
      avatar: "🦞",
    });
    expect(JSON.parse(localStorage.getItem("openclaw.control.user.v1") ?? "{}")).toEqual({
      name: "Buns",
      avatar: "🦞",
    });
  });

  it("normalizes invalid local user identity values on load", () => {
    localStorage.setItem(
      "openclaw.control.user.v1",
      JSON.stringify({
        name: "  ",
        avatar: "https://example.com/avatar.png",
      }),
    );

    expect(loadLocalUserIdentity()).toEqual({
      name: null,
      avatar: null,
    });
  });
});
