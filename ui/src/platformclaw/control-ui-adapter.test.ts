import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { createPlatformClawControlUiAdapter } from "./control-ui-adapter.ts";
import { loadAllPlatformClawLocales } from "./i18n.ts";
import {
  PLATFORMCLAW_SESSION_CHECK_TIMEOUT_MS,
  PLATFORMCLAW_WEB_DESCRIPTOR,
  type PlatformClawSessionIdentity,
} from "./web-contract.ts";

const employeeIdentity: PlatformClawSessionIdentity = {
  accountId: "person.one",
  agentId: "person_one",
  displayName: "Person One",
  department: "Platform",
  globalRole: "member",
};

function activeSession(identity = employeeIdentity): Response {
  const { agentId, ...user } = identity;
  return jsonResponse({ authenticated: true, user, agent: { agentId, state: "active" } });
}

function pendingResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function recoveryAdapter(fetchImpl: typeof fetch) {
  installDescriptor();
  const navigate = vi.fn();
  const adapter = createPlatformClawControlUiAdapter({
    location: {
      href: "https://platformclaw.example/platformclaw/app/chat?draft=1#composer",
      origin: "https://platformclaw.example",
      protocol: "https:",
    },
    fetchImpl,
    navigate,
  })!;
  const options = adapter.applicationOptions(employeeIdentity, vi.fn());
  const close = (code = 1006) => options.gateway!.onClose!({ code, reason: "", willRetry: true });
  return { adapter, close, navigate };
}

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
  });

  afterEach(async () => {
    vi.useRealTimers();
    document.head.replaceChildren();
    document.body.replaceChildren();
    await i18n.setLocale("en");
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
        agent: { agentId: "person_one", state: "active" },
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
      agentId: "person_one",
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
        "credentials",
        "memory",
        "organization",
        "spaces",
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
          "route:spaces",
          "route:cron",
          "route:skills",
          "route:skill-workshop",
          "route:skill-hub",
        ],
      },
      gateway: {
        url: "wss://platformclaw.example/platformclaw/gateway",
        browserDeviceAuth: false,
        canvasSurfaceRelayRequired: true,
      },
      shellSession: {
        primaryLabel: "Jung Seungon",
        secondaryLabel: "Platform",
        localPreferenceScope: JSON.stringify([
          "wss://platformclaw.example/platformclaw/gateway",
          "person.one",
        ]),
      },
    });
    expect(options.routeOverrides?.organization).toBeDefined();
    expect(options.chatWorkingTip).toEqual(expect.any(Function));
    expect(options.shellSession?.renderMainBanner).toEqual(expect.any(Function));
    expect(options.shellSession?.renderPageHeaderAccessory).toEqual(expect.any(Function));
    const organizationTitle = options.navigation?.routeCopy?.organization?.title;
    expect(typeof organizationTitle === "function" ? organizationTitle() : organizationTitle).toBe(
      "Organization",
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "/platformclaw/api/auth/session",
      expect.objectContaining({ credentials: "same-origin", method: "GET" }),
    );
  });

  it.each([1006, 1008])("rechecks session authority after close %i", async (code) => {
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
          agent: { agentId: "person_one", state: "active" },
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
      code,
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

  it("coalesces reconnect, policy-close, and explicit session checks", async () => {
    const pending = pendingResponse();
    const fetchImpl = vi.fn<typeof fetch>(() => pending.promise);
    const { adapter, close, navigate } = recoveryAdapter(fetchImpl);
    close();
    close(1008);
    const loading = adapter.loadSession();
    expect(fetchImpl).toHaveBeenCalledOnce();

    pending.resolve(jsonResponse({ authenticated: false }));
    await loading;

    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      "/platformclaw/login?returnTo=%2Fplatformclaw%2Fapp%2Fchat%3Fdraft%3D1%23composer",
    );
  });

  it("aborts a stalled probe without logging out and checks the next reconnect afresh", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            signal = init?.signal ?? undefined;
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              {
                once: true,
              },
            );
          }),
      )
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }));
    const { adapter, close, navigate } = recoveryAdapter(fetchImpl);
    close();
    const unavailable = expect(adapter.loadSession()).rejects.toThrow(
      "session service is unavailable",
    );

    await vi.advanceTimersByTimeAsync(PLATFORMCLAW_SESSION_CHECK_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    close(1008);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await unavailable;
    expect(signal?.aborted).toBe(true);
    expect(navigate).not.toHaveBeenCalled();

    close();
    await expect(adapter.loadSession()).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("aborts disposal immediately and leaves a replacement probe owned by the new shell", async () => {
    vi.useFakeTimers();
    const first = pendingResponse();
    const second = pendingResponse();
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      signals.push(init!.signal!);
      return signals.length === 1 ? first.promise : second.promise;
    });
    const { adapter, close, navigate } = recoveryAdapter(fetchImpl);
    close();
    const stale = adapter.loadSession();
    adapter.dispose();
    expect(signals[0]?.aborted).toBe(true);
    const replacement = adapter.applicationOptions(employeeIdentity, vi.fn());
    const closeReplacement = () =>
      replacement.gateway!.onClose!({ code: 1006, reason: "", willRetry: true });
    closeReplacement();
    const current = adapter.loadSession();

    first.resolve(jsonResponse({ authenticated: false }));
    await expect(stale).resolves.toBeNull();
    closeReplacement();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(false);
    second.resolve(activeSession());
    await expect(current).resolves.toEqual(employeeIdentity);
    await vi.advanceTimersByTimeAsync(PLATFORMCLAW_SESSION_CHECK_TIMEOUT_MS);
    expect(signals[1]?.aborted).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "active session",
      response: () => Promise.resolve(activeSession()),
      unavailable: false,
    },
    {
      name: "service failure",
      response: () => Promise.resolve(jsonResponse({}, 503)),
      unavailable: true,
    },
    {
      name: "network failure",
      response: () => Promise.reject(new Error("offline")),
      unavailable: true,
    },
    {
      name: "malformed session",
      response: () => Promise.resolve(jsonResponse({ authenticated: true })),
      unavailable: true,
    },
  ])(
    "preserves reconnect through $name and checks again after recovery",
    async ({ response, unavailable }) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(response)
        .mockResolvedValueOnce(jsonResponse({ authenticated: false }));
      const { adapter, close, navigate } = recoveryAdapter(fetchImpl);
      close();
      if (unavailable) {
        await expect(adapter.loadSession()).rejects.toThrow("session service is unavailable");
      } else {
        await expect(adapter.loadSession()).resolves.toEqual(employeeIdentity);
      }
      expect(navigate).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledOnce();

      close();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["dispose", "replace", "logout"] as const)(
    "ignores pending and old callbacks after %s",
    async (action) => {
      const pending = pendingResponse();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(jsonResponse({ ok: true }));
      const { adapter, close, navigate } = recoveryAdapter(fetchImpl);
      close();
      const loading = adapter.loadSession();
      if (action === "dispose") {
        adapter.dispose();
      } else if (action === "replace") {
        adapter.applicationOptions({ ...employeeIdentity, accountId: "person.two" }, vi.fn());
      } else {
        await adapter.logout(vi.fn());
      }
      pending.resolve(jsonResponse({ authenticated: false }));
      await expect(loading).resolves.toBeNull();
      close(1008);

      expect(fetchImpl).toHaveBeenCalledTimes(action === "logout" ? 2 : 1);
      if (action === "logout") {
        expect(navigate).toHaveBeenCalledExactlyOnceWith("/platformclaw/login");
      } else {
        expect(navigate).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { accountId: "person.two" },
    { agentId: "person_two" },
    { globalRole: "admin" as const },
  ])("rebuilds the shell when authenticated authority changes: %j", async (changed) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      activeSession({ ...employeeIdentity, ...changed }),
    );
    const { close, navigate } = recoveryAdapter(fetchImpl);
    close();

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledExactlyOnceWith("/platformclaw/app/chat?draft=1#composer"),
    );
    close();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    "https://other.example/platformclaw/app/chat",
    "https://platformclaw.example/platformclaw/application",
  ])("excludes unsafe return locations: %s", async (href) => {
    installDescriptor();
    const navigate = vi.fn();
    const adapter = createPlatformClawControlUiAdapter({
      location: { href, origin: "https://platformclaw.example", protocol: "https:" },
      fetchImpl: async () => jsonResponse({ authenticated: false }),
      navigate,
    })!;

    await expect(adapter.loadSession()).resolves.toBeNull();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/platformclaw/login");
  });

  it("loads standalone Memory for the assigned personal agent without global config", async () => {
    installDescriptor();
    const adapter = createPlatformClawControlUiAdapter()!;
    const options = adapter.applicationOptions(
      {
        accountId: "person.one",
        agentId: "assigned-personal",
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
        { location: { pathname: "/settings/memory" } } as never,
      ),
    ).resolves.toEqual({ agentId: "assigned-personal", initialTab: "memory" });
    await expect(
      loader?.(
        {
          basePath: "/platformclaw/app",
          agents: {
            state: {
              agentsList: {
                agents: [{ id: "assigned-personal", name: "Assigned" }],
                defaultId: "assigned-personal",
              },
            },
          },
        } as never,
        {
          location: {
            pathname: "/platformclaw/app/settings/memory",
            search: "?__openclawMemoryPath=%2Fplatformclaw%2Fapp%2Fsettings%2Fmemory%2Fdreams",
          },
        } as never,
      ),
    ).resolves.toEqual({ agentId: "assigned-personal", initialTab: "dreaming" });
    expect(ensureList).not.toHaveBeenCalled();
  });

  it("preserves the Vault tab through loader and rendered route data", async () => {
    installDescriptor();
    const options = createPlatformClawControlUiAdapter()!.applicationOptions(
      {
        accountId: "person.one",
        agentId: "assigned-personal",
        displayName: "Person One",
        department: "Platform",
        globalRole: "member",
      },
      vi.fn(),
    );
    const route = options.routeOverrides!.memory!;
    const routeData = await route.loader!(
      { basePath: "/platformclaw/app" } as never,
      {
        location: {
          pathname: "/platformclaw/app/settings/memory",
          search: "?__openclawMemoryPath=%2Fplatformclaw%2Fapp%2Fsettings%2Fmemory%2Fvaults",
        },
      } as never,
    );
    const component = await route.component!();
    const container = document.createElement("div");
    render(component.render(routeData), container);
    const page = container.querySelector("platformclaw-memory-page") as HTMLElement & {
      initialTab: string;
    };
    expect(page.initialTab).toBe("vaults");
  });

  it("uses the authenticated personal binding before the Gateway agent list loads", async () => {
    installDescriptor();
    const adapter = createPlatformClawControlUiAdapter()!;
    const options = adapter.applicationOptions(
      {
        accountId: "person.one",
        agentId: "assigned-personal",
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
      { location: { pathname: "/settings/memory" } } as never,
    );
    expect(routeData).toEqual({ agentId: "assigned-personal", initialTab: "memory" });

    const component = await options.routeOverrides?.memory?.component?.();
    const container = document.createElement("div");
    render(component?.render(routeData), container);
    expect(container.querySelector("platformclaw-memory-page")).not.toBeNull();
  });

  it("stops the app and redirects even when logout fails", async () => {
    installDescriptor();
    const stopApplication = vi.fn();
    const navigate = vi.fn();
    const sessionStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
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
    expect(sessionStorage.removeItem).toHaveBeenCalledWith(
      "platformclaw.organizationJoinPrompt.dismissed",
    );
  });

  it("defers automatic announcement dialogs only on administration pages and keeps localized route labels", async () => {
    installDescriptor();
    await loadAllPlatformClawLocales();
    const options = createPlatformClawControlUiAdapter()!.applicationOptions(
      {
        accountId: "admin.user",
        agentId: "admin_user",
        displayName: "Administrator",
        department: "Platform",
        globalRole: "admin",
      },
      vi.fn(),
    );
    await customElements.whenDefined("platformclaw-announcements");
    const banner = document.createElement("div");
    let viewer: Element | null = null;
    for (const routeId of ["announcements", "vm-administration", "chat"] as const) {
      render(options.shellSession?.renderMainBanner?.(routeId, undefined), banner);
      const nextViewer = banner.querySelector<HTMLElement & { deferAutomatic: boolean }>(
        "platformclaw-announcements",
      )!;
      expect(nextViewer.deferAutomatic).toBe(routeId !== "chat");
      if (viewer) {
        expect(nextViewer).toBe(viewer);
      }
      viewer = nextViewer;
    }
    const copy = options.navigation?.routeCopy;
    const title = (routeId: "announcements" | "vm-administration") => {
      const value = copy?.[routeId]?.title;
      return typeof value === "function" ? value() : value;
    };
    await i18n.setLocale("en");
    expect(title("announcements")).toBe("Web announcements");
    expect(title("vm-administration")).toBe("VM administration");
    await i18n.setLocale("ko");
    expect(title("announcements")).toBe("웹 공지 관리");
    expect(title("vm-administration")).toBe("VM 관리");
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
        agentId: "admin_user",
        displayName: "Administrator",
        department: "Platform",
        globalRole: "admin",
      },
      vi.fn(),
    );
    expect(adminOptions.enabledRouteIds).toContain("plugins");
    expect(adminOptions.enabledRouteIds).toContain("mcp");
    expect(adminOptions.enabledRouteIds).toContain("credentials");
    expect(adminOptions.enabledRouteIds).toContain("announcements");
    expect(adminOptions.enabledRouteIds).toContain("vm-administration");
    expect(adminOptions.navigation?.sidebarEntries).toEqual([
      "route:spaces",
      "route:cron",
      "route:skills",
      "route:skill-workshop",
      "route:skill-hub",
    ]);
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
      adminQuickActions.shadowRoot?.querySelectorAll('[data-action="work-location"]'),
    ).toHaveLength(1);
    expect(
      adminQuickActions.shadowRoot?.querySelector("platformclaw-vm-administration"),
    ).toBeNull();
    expect(
      adminQuickActions.shadowRoot?.querySelector("platformclaw-announcement-administration"),
    ).toBeNull();
    const administrationPages = document.createElement("div");
    for (const [routeId, tag] of [
      ["announcements", "platformclaw-announcement-administration"],
      ["vm-administration", "platformclaw-vm-administration"],
    ] as const) {
      const module = await adminOptions.routeOverrides?.[routeId]?.component?.();
      render(module?.render(undefined), administrationPages);
      const page = administrationPages.querySelector<
        HTMLElement & {
          fetchImpl: typeof fetch;
          onUnauthenticated: () => void;
        }
      >(tag)!;
      expect(page).not.toBeNull();
      expect(page.fetchImpl).toBe(fetchImpl);
      expect(administrationPages.querySelectorAll(".page-title")).toHaveLength(1);
      page.onUnauthenticated();
    }
    expect(navigate).toHaveBeenCalledWith("/platformclaw/login");
    const adminCredentialsModule = await adminOptions.routeOverrides?.credentials?.component?.();
    render(adminCredentialsModule?.render(undefined), document.body);
    expect(document.querySelector("platformclaw-exec-credentials")).not.toBeNull();
    const adminMcpModule = await adminOptions.routeOverrides?.mcp?.component?.();
    render(adminMcpModule?.render(undefined), document.body);
    expect(document.querySelector("platformclaw-exec-credentials")).toBeNull();
    expect(document.querySelector("platformclaw-mcp-administration")).not.toBeNull();
    expect(document.querySelector("platformclaw-mcp-settings")).not.toBeNull();

    const memberOptions = adapter.applicationOptions(
      {
        accountId: "person.one",
        agentId: "person_one",
        displayName: "Person One",
        department: "Platform",
        globalRole: "member",
      },
      vi.fn(),
    );
    expect(memberOptions.enabledRouteIds).not.toContain("plugins");
    for (const routeId of ["announcements", "vm-administration"] as const) {
      expect(memberOptions.enabledRouteIds).not.toContain(routeId);
      expect(memberOptions.routeOverrides?.[routeId]).toBeUndefined();
    }
    expect(memberOptions.enabledRouteIds).toContain("mcp");
    expect(memberOptions.enabledRouteIds).toContain("credentials");
    expect(memberOptions.navigation?.sidebarEntries).toEqual([
      "route:spaces",
      "route:cron",
      "route:skills",
      "route:skill-workshop",
      "route:skill-hub",
    ]);
    expect(memberOptions.navigation?.sidebarRouteTargets).toBeUndefined();
    expect(memberOptions.navigation?.settingsNavigationMode).toBe("takeover");
    render(memberOptions.shellSession?.renderFooterAccessory?.(), document.body);

    await vi.waitFor(() => {
      expect(document.querySelectorAll("platformclaw-quick-actions")).toHaveLength(1);
    });
    const memberQuickActions = document.querySelector("platformclaw-quick-actions")!;
    await (memberQuickActions as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
    expect(
      memberQuickActions.shadowRoot?.querySelectorAll('[data-action="work-location"]'),
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
