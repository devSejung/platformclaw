import { beforeEach, describe, expect, it, vi } from "vitest";
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
    });
    const options = adapter!.applicationOptions(identity!, vi.fn());
    expect(options).toMatchObject({
      accessMode: "personal-agent",
      enabledRouteIds: ["chat", "new-session", "sessions", "agents"],
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
          user: { accountId: "person.one", displayName: "Person One", department: "Lab" },
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
});
