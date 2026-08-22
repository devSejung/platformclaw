import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformClawControlUiAdapter } from "./control-ui-adapter.ts";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "./web-contract.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installDescriptor(): void {
  document.head.innerHTML = `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'>`;
}

describe("PlatformClawControlUiAdapter", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    localStorage.setItem("platformclaw.product-tour.v1.completed", "true");
  });

  afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it("stays inactive for the unmodified upstream Control UI document", () => {
    expect(createPlatformClawControlUiAdapter()).toBeNull();
  });

  it("loads server identity and fixes browser authority to the same-origin proxy", async () => {
    installDescriptor();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        authenticated: true,
        user: {
          accountId: "person.one",
          displayName: "Jung Seungon",
          department: "Platform",
          globalRole: "member",
        },
      }),
    );
    const adapter = createPlatformClawControlUiAdapter({
      location: {
        href: "https://platformclaw.example/platformclaw/app/chat",
        origin: "https://platformclaw.example",
        protocol: "https:",
      },
      fetchImpl,
      navigate: vi.fn(),
    });

    expect(adapter).not.toBeNull();
    const identity = await adapter!.loadSession();
    expect(identity).toEqual({
      accountId: "person.one",
      displayName: "Jung Seungon",
      department: "Platform",
      globalRole: "member",
    });
    const options = adapter!.applicationOptions(identity!, vi.fn());
    expect(options).toMatchObject({
      accessMode: "personal-agent",
      enabledRouteIds: [
        "chat",
        "new-session",
        "activity",
        "sessions",
        "usage",
        "agents",
        "tasks",
        "cron",
        "appearance",
        "memory",
        "profile",
        "notifications",
        "about",
        "skills",
        "skill-workshop",
        "skill-hub",
        "mcp",
      ],
      navigation: {
        sidebarEntries: [
          "route:usage",
          "route:tasks",
          "route:sessions",
          "route:activity",
          "route:cron",
          "route:plugins",
        ],
        sidebarRouteTargets: { plugins: "skills" },
      },
      gateway: {
        url: "wss://platformclaw.example/platformclaw/gateway",
        browserDeviceAuth: false,
      },
      shellSession: {
        primaryLabel: "Jung Seungon",
        secondaryLabel: "Platform",
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/platformclaw/api/auth/session",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
  });

  it("redirects an inactive session and rechecks after a policy close", async () => {
    installDescriptor();
    const navigate = vi.fn();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          user: {
            accountId: "person.one",
            displayName: "Person One",
            department: "Lab",
            globalRole: "member",
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }));
    const adapter = createPlatformClawControlUiAdapter({
      location: {
        href: "https://platformclaw.example/platformclaw/app/sessions?active=1",
        origin: "https://platformclaw.example",
        protocol: "https:",
      },
      fetchImpl,
      navigate,
    })!;
    const identity = await adapter.loadSession();
    adapter.applicationOptions(identity!, vi.fn()).gateway?.onClose?.({
      code: 1008,
      reason: "session expired",
      willRetry: true,
    });

    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        "/platformclaw/login?returnTo=%2Fplatformclaw%2Fapp%2Fsessions%3Factive%3D1",
      );
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("loads standalone Memory for the assigned personal agent without global config", async () => {
    installDescriptor();
    const adapter = createPlatformClawControlUiAdapter()!;
    const options = adapter.applicationOptions(
      {
        accountId: "person.one",
        displayName: "Person One",
        department: "Platform",
        globalRole: "member",
      },
      vi.fn(),
    );
    const ensureList = vi.fn(async () => ({
      agents: [
        { id: "assigned-personal", name: "Assigned" },
        { id: "foreign-agent", name: "Foreign" },
      ],
      defaultId: "assigned-personal",
      mainKey: "assigned-personal",
      scope: "agent" as const,
    }));
    const loader = options.routeOverrides?.memory?.loader;

    await expect(
      loader?.(
        {
          agents: { state: { agentsList: null }, ensureList },
        } as never,
        {} as never,
      ),
    ).resolves.toEqual({ agentId: "assigned-personal" });
    expect(ensureList).toHaveBeenCalledOnce();
  });

  it("renders a visible unavailable state when no personal agent is assigned", async () => {
    installDescriptor();
    const adapter = createPlatformClawControlUiAdapter()!;
    const options = adapter.applicationOptions(
      {
        accountId: "person.one",
        displayName: "Person One",
        department: "Platform",
        globalRole: "member",
      },
      vi.fn(),
    );
    const loader = options.routeOverrides?.memory?.loader;

    const routeData = await loader?.(
      {
        agents: {
          state: { agentsList: { agents: [], defaultId: null } },
          ensureList: vi.fn(),
        },
      } as never,
      {} as never,
    );
    expect(routeData).toEqual({ agentId: null });

    const component = await options.routeOverrides?.memory?.component?.();
    const container = document.createElement("div");
    render(component?.render(routeData), container);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "No personal agent is assigned",
    );
  });

  it("stops the app and redirects even when logout fails", async () => {
    installDescriptor();
    const stopApplication = vi.fn();
    const navigate = vi.fn();
    const sessionStorage = { removeItem: vi.fn() };
    const adapter = createPlatformClawControlUiAdapter({
      location: {
        href: "https://platformclaw.example/platformclaw/app/chat",
        origin: "https://platformclaw.example",
        protocol: "https:",
      },
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new Error("network unavailable");
      }),
      navigate,
      sessionStorage,
    })!;

    await expect(adapter.logout(stopApplication)).resolves.toBeUndefined();
    expect(stopApplication).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/platformclaw/login");
    expect(sessionStorage.removeItem).toHaveBeenCalledWith(
      "openclaw.control.chatComposer.v2:wss%3A%2F%2Fplatformclaw.example%2Fplatformclaw%2Fgateway",
    );
  });

  it("keeps account accessories compact and exposes the MCP route by role", async () => {
    installDescriptor();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const inputUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (inputUrl.endsWith("/platformclaw/api/execution")) {
        return jsonResponse({
          activeTarget: "platform_server",
          targetRevision: 0,
          credentialStatus: "missing",
          accountId: "admin.user",
          availableVms: [],
          assignment: null,
        });
      }
      return jsonResponse({
        endpoints: [],
        hosts: [],
        agents: [],
        allocations: [],
        auditEvents: [],
      });
    });
    const navigate = vi.fn();
    const adapter = createPlatformClawControlUiAdapter({
      fetchImpl,
      navigate,
    })!;

    const adminOptions = adapter.applicationOptions(
      {
        accountId: "admin.user",
        displayName: "Administrator",
        department: "Platform",
        globalRole: "admin",
      },
      vi.fn(),
    );
    expect(adminOptions.enabledRouteIds).toContain("plugins");
    expect(adminOptions.enabledRouteIds).toContain("mcp");
    expect(adminOptions.navigation?.sidebarEntries).toContain("route:plugins");
    expect(adminOptions.navigation?.settingsNavigationMode).toBe("takeover");
    render(adminOptions.shellSession?.renderFooterAccessory?.(), document.body);

    await vi.waitFor(() => {
      expect(document.querySelectorAll("platformclaw-quick-actions")).toHaveLength(1);
    });
    expect(document.querySelector(".platformclaw-mcp-navigation")).toBeNull();
    expect(document.querySelectorAll("platformclaw-mcp-settings")).toHaveLength(0);
    const adminQuickActions = document.querySelector("platformclaw-quick-actions")!;
    await (adminQuickActions as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
    expect(
      adminQuickActions.shadowRoot?.querySelectorAll("platformclaw-execution-settings"),
    ).toHaveLength(1);
    expect(
      adminQuickActions.shadowRoot?.querySelectorAll("platformclaw-vm-administration"),
    ).toHaveLength(1);
    await customElements.whenDefined("platformclaw-vm-administration");
    const administration = adminQuickActions.shadowRoot?.querySelector(
      "platformclaw-vm-administration",
    ) as HTMLElement & {
      fetchImpl: typeof fetch;
      onUnauthenticated: () => void;
    };
    expect(administration.fetchImpl).toBe(fetchImpl);
    administration.onUnauthenticated();
    expect(navigate).toHaveBeenCalledWith("/platformclaw/login");
    const adminMcpModule = await adminOptions.routeOverrides?.mcp?.component?.();
    render(adminMcpModule?.render(undefined), document.body);
    expect(document.querySelector("platformclaw-mcp-administration")).not.toBeNull();
    expect(document.querySelector("platformclaw-mcp-settings")).not.toBeNull();

    const memberOptions = adapter.applicationOptions(
      {
        accountId: "person.one",
        displayName: "Person One",
        department: "Platform",
        globalRole: "member",
      },
      vi.fn(),
    );
    expect(memberOptions.enabledRouteIds).not.toContain("plugins");
    expect(memberOptions.enabledRouteIds).toContain("mcp");
    expect(memberOptions.navigation?.sidebarEntries).toContain("route:plugins");
    expect(memberOptions.navigation?.sidebarEntries).not.toContain("route:skills");
    expect(memberOptions.navigation?.sidebarRouteTargets).toEqual({ plugins: "skills" });
    expect(memberOptions.navigation?.settingsNavigationMode).toBe("takeover");
    render(memberOptions.shellSession?.renderFooterAccessory?.(), document.body);

    await vi.waitFor(() => {
      expect(document.querySelectorAll("platformclaw-quick-actions")).toHaveLength(1);
    });
    const memberQuickActions = document.querySelector("platformclaw-quick-actions")!;
    await (memberQuickActions as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
    expect(
      memberQuickActions.shadowRoot?.querySelectorAll("platformclaw-execution-settings"),
    ).toHaveLength(1);
    expect(document.querySelectorAll("platformclaw-mcp-settings")).toHaveLength(0);
    expect(
      memberQuickActions.shadowRoot?.querySelector("platformclaw-vm-administration"),
    ).toBeNull();
    const memberMcpModule = await memberOptions.routeOverrides?.mcp?.component?.();
    render(memberMcpModule?.render(undefined), document.body);
    expect(document.querySelector("platformclaw-mcp-administration")).toBeNull();
    expect(document.querySelector("platformclaw-mcp-settings")).not.toBeNull();
  });
});
