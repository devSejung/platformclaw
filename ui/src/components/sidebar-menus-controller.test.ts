import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import {
  createContext,
  createGateway,
  createSessions,
  TWO_AGENTS,
} from "../test-helpers/app-sidebar.ts";
import {
  SidebarMenusController,
  type SidebarMenusControllerHost,
} from "./sidebar-menus-controller.ts";

describe("SidebarMenusController session routes", () => {
  it("uses the product route title instead of the stock fallback", () => {
    const host = {
      addController: vi.fn(),
      requestUpdate: vi.fn(),
      activeRouteId: "spaces",
      activeWorkboardBoardId: "",
      basePath: "/platformclaw/app",
      enabledRouteIds: ["spaces"],
      sidebarRouteTargets: {},
      navigationCopy: { spaces: { title: () => "Spaces", subtitle: "Shared issues" } },
      onNavigate: vi.fn(),
    } as unknown as SidebarMenusControllerHost;
    const container = document.createElement("div");
    render(new SidebarMenusController(host).renderRoute("spaces"), container);
    expect(container.querySelector("a")?.textContent?.trim()).toBe("Spaces");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/platformclaw/app/spaces");
  });

  it("keeps the current catalog session when switching either face", () => {
    const sessionKey = buildCatalogSessionKey({
      catalogId: "claude",
      hostId: "gateway:local",
      threadId: "thread-1",
    });
    const context = createContext(
      createGateway({} as GatewayBrowserClient),
      createSessions("main", [sessionKey]),
      TWO_AGENTS,
    );
    Object.assign(context, { basePath: "" });
    const onNavigate = vi.fn();
    const host = {
      activeRouteId: "chat",
      activeWorkboardBoardId: "",
      addController: vi.fn(),
      basePath: "",
      enabledRouteIds: ["chat", "dashboard"],
      getRouteSessionKey: () => sessionKey,
      onNavigate,
      requestUpdate: vi.fn(),
      sessionDataContext: context,
      sidebarRouteTargets: {},
      terminalAvailable: false,
    } as unknown as SidebarMenusControllerHost;
    const controller = new SidebarMenusController(host);
    const container = document.createElement("div");

    render(controller.renderRoute("chat"), container);
    const chat = container.querySelector<HTMLAnchorElement>("a");
    expect(chat?.getAttribute("href")).toBe(
      "/chat/main?catalog=claude&host=gateway%3Alocal&thread=thread-1",
    );
    chat?.click();
    expect(onNavigate).toHaveBeenLastCalledWith("chat", {
      pathname: "/chat/main",
      search: "?catalog=claude&host=gateway%3Alocal&thread=thread-1",
    });

    render(controller.renderRoute("dashboard"), container);
    const dashboard = container.querySelector<HTMLAnchorElement>("a");
    expect(dashboard?.getAttribute("href")).toBe(
      "/dashboard/main?catalog=claude&host=gateway%3Alocal&thread=thread-1",
    );
    dashboard?.click();
    expect(onNavigate).toHaveBeenLastCalledWith("dashboard", {
      pathname: "/dashboard/main",
      search: "?catalog=claude&host=gateway%3Alocal&thread=thread-1",
    });
  });
});
