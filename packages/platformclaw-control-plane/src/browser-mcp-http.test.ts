import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { EmployeeMcpService, handlePlatformClawEmployeeMcpRequest } from "./browser-mcp-http.js";

function harness() {
  const adminRpc = {
    call: vi.fn(async (method: string) => {
      if (method === "platformclaw-user-mcp.catalog") {
        return {
          servers: [
            {
              serverName: "docs",
              auth: "api_key",
              headerName: "X-Approved-Key",
              url: "https://mcp.example.test/docs",
            },
            {
              serverName: "oauth",
              auth: "oauth",
              url: "https://mcp.example.test/oauth",
              scope: "read",
            },
          ],
        };
      }
      return { disposed: 1 };
    }),
  };
  const store = {
    getPersonalAgentBinding: vi.fn(async () => ({
      id: "binding-one",
      kind: "personal",
      userId: "user-one",
      agentId: "person_one",
      state: "active",
      createdAt: 1,
      updatedAt: 1,
    })),
    listUserMcpCredentials: vi.fn(async () => []),
    deleteUserMcpCredential: vi.fn(async () => true),
  };
  const vault = {
    replace: vi.fn(async (params: { serverName: string }) => ({
      userId: "user-one",
      serverName: params.serverName,
      kind: "api_key",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    })),
    readPayload: vi.fn(async () => null),
    readForUser: vi.fn(async () => null),
    readForAgent: vi.fn(async () => null),
    resolveForAgent: vi.fn(async () => null),
  };
  const service = new EmployeeMcpService({
    authService: {} as never,
    store: store as never,
    vault: vault as never,
    adminRpc: adminRpc as never,
    publicOrigin: "https://claw.example.test",
    now: () => 5_000,
  });
  return { adminRpc, service, store, vault };
}

describe("EmployeeMcpService", () => {
  it("pins API-key header policy server-side and invalidates the Agent runtime", async () => {
    const { adminRpc, service, vault } = harness();

    await expect(
      service.replace({
        userId: "user-one",
        agentId: "person_one",
        serverName: "docs",
        kind: "api_key",
        secret: "employee-secret",
      }),
    ).resolves.toEqual({ serverName: "docs", revision: 1 });

    expect(vault.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "docs",
        payload: {
          kind: "api_key",
          serverUrl: "https://mcp.example.test/docs",
          headerName: "X-Approved-Key",
          value: "employee-secret",
        },
      }),
    );
    expect(adminRpc.call).toHaveBeenLastCalledWith("platformclaw-user-mcp.invalidateAgent", {
      agentId: "person_one",
    });
  });

  it("rejects arbitrary servers and credential-kind changes", async () => {
    const { service, vault } = harness();

    await expect(
      service.replace({
        userId: "user-one",
        agentId: "person_one",
        serverName: "arbitrary",
        kind: "bearer",
        secret: "secret",
      }),
    ).rejects.toThrow("not administrator-approved");
    await expect(
      service.replace({
        userId: "user-one",
        agentId: "person_one",
        serverName: "docs",
        kind: "bearer",
        secret: "secret",
      }),
    ).rejects.toThrow("not administrator-approved");
    expect(vault.replace).not.toHaveBeenCalled();
  });

  it("fails closed when stored credential kind no longer matches policy", async () => {
    const { service, vault } = harness();
    vault.readForAgent.mockResolvedValueOnce({
      userId: "user-one",
      serverName: "docs",
      revision: 1,
      payload: {
        kind: "bearer",
        serverUrl: "https://mcp.example.test/docs",
        token: "old-secret",
      },
    } as never);

    await expect(service.resolveForAgent("person_one", "docs")).resolves.toBeNull();
    expect(vault.resolveForAgent).not.toHaveBeenCalled();
  });

  it("does not show stale or undecryptable credentials as connected", async () => {
    const { service, store, vault } = harness();
    store.listUserMcpCredentials.mockResolvedValue([
      {
        userId: "user-one",
        serverName: "docs",
        kind: "api_key",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        userId: "user-one",
        serverName: "oauth",
        kind: "oauth",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ] as never);
    vault.readForUser.mockRejectedValueOnce(new Error("decryption failed")).mockResolvedValueOnce({
      userId: "user-one",
      serverName: "oauth",
      revision: 1,
      payload: {
        kind: "oauth",
        serverUrl: "https://mcp.example.test/oauth",
        scope: "write",
        tokens: { access_token: "old-token", token_type: "Bearer" },
      },
    } as never);

    await expect(service.getSettings("user-one")).resolves.toEqual({
      servers: [
        expect.objectContaining({ serverName: "docs", configured: false }),
        expect.objectContaining({ serverName: "oauth", configured: false }),
      ],
    });
  });

  it("fails closed when a stored credential is bound to another endpoint", async () => {
    const { service, vault } = harness();
    vault.readForAgent.mockResolvedValueOnce({
      userId: "user-one",
      serverName: "docs",
      revision: 1,
      payload: {
        kind: "api_key",
        serverUrl: "https://old-mcp.example.test/docs",
        headerName: "X-Approved-Key",
        value: "old-secret",
      },
    } as never);

    await expect(service.resolveForAgent("person_one", "docs")).resolves.toBeNull();
    expect(vault.resolveForAgent).not.toHaveBeenCalled();
  });

  it("fails closed when an administrator changes a pinned header or OAuth scope", async () => {
    const { service, vault } = harness();
    vault.readForAgent
      .mockResolvedValueOnce({
        userId: "user-one",
        serverName: "docs",
        revision: 1,
        payload: {
          kind: "api_key",
          serverUrl: "https://mcp.example.test/docs",
          headerName: "X-Old-Key",
          value: "old-secret",
        },
      } as never)
      .mockResolvedValueOnce({
        userId: "user-one",
        serverName: "oauth",
        revision: 1,
        payload: {
          kind: "oauth",
          serverUrl: "https://mcp.example.test/oauth",
          scope: "write",
          tokens: { access_token: "old-token", token_type: "Bearer" },
        },
      } as never);

    await expect(service.resolveForAgent("person_one", "docs")).resolves.toBeNull();
    await expect(service.resolveForAgent("person_one", "oauth")).resolves.toBeNull();
    expect(vault.resolveForAgent).not.toHaveBeenCalled();
  });

  it("rejects a handoff request for a different Gateway endpoint", async () => {
    const { service, vault } = harness();

    await expect(
      service.resolveForAgent("person_one", "docs", "https://other.example.test/docs"),
    ).resolves.toBeNull();
    expect(vault.readForAgent).not.toHaveBeenCalled();
  });

  it("retries runtime revocation after deletion succeeded but invalidation failed", async () => {
    const { adminRpc, service, store } = harness();
    await service.getSettings("user-one");
    adminRpc.call.mockRejectedValueOnce(new Error("Gateway unavailable"));
    store.deleteUserMcpCredential.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(service.remove("user-one", "person_one", "docs")).rejects.toThrow(
      "Gateway unavailable",
    );
    await expect(service.remove("user-one", "person_one", "docs")).resolves.toEqual({
      deleted: false,
    });

    expect(adminRpc.call).toHaveBeenLastCalledWith("platformclaw-user-mcp.invalidateAgent", {
      agentId: "person_one",
    });
  });

  it("retries a transient catalog bootstrap failure", async () => {
    const { adminRpc, service } = harness();
    adminRpc.call.mockRejectedValueOnce(new Error("Gateway unavailable"));

    await expect(service.getSettings("user-one")).rejects.toThrow("Gateway unavailable");
    await expect(service.getSettings("user-one")).resolves.toEqual({
      servers: expect.arrayContaining([expect.objectContaining({ serverName: "docs" })]),
    });
  });

  it("reloads an initially empty catalog after an administrator changes MCP policy", async () => {
    const { adminRpc, service } = harness();
    adminRpc.call.mockResolvedValueOnce({ servers: [] });
    await expect(service.getSettings("user-one")).resolves.toEqual({ servers: [] });

    service.invalidateCatalog();

    await expect(service.getSettings("user-one")).resolves.toEqual({
      servers: expect.arrayContaining([expect.objectContaining({ serverName: "docs" })]),
    });
    expect(
      adminRpc.call.mock.calls.filter(([method]) => method === "platformclaw-user-mcp.catalog"),
    ).toHaveLength(2);
  });
});

describe("MCP OAuth browser callback", () => {
  it.each([
    ["success", "/platformclaw/api/mcp/oauth/callback?state=state&code=code", false],
    ["error", "/platformclaw/api/mcp/oauth/callback?state=state&error=denied", false],
    ["error", "/platformclaw/api/mcp/oauth/callback?state=state&code=code", true],
  ] as const)("redirects the browser to an app %s result", async (result, url, failComplete) => {
    const headers = new Map<string, string>();
    const response = {
      statusCode: 0,
      setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
      end: vi.fn(),
    } as unknown as ServerResponse;
    const request = {
      method: "GET",
      url,
      headers: { cookie: "platformclaw_session=session-token" },
    } as IncomingMessage;
    const completeOAuth = failComplete
      ? vi.fn(async () => {
          throw new Error("provider failure");
        })
      : vi.fn(async () => undefined);
    const cancelOAuth = vi.fn(async () => undefined);
    const service = {
      authenticate: vi.fn(async () => ({
        user: { id: "user-one" },
        binding: { agentId: "person_one" },
      })),
      completeOAuth,
      cancelOAuth,
    };

    await expect(
      handlePlatformClawEmployeeMcpRequest(request, response, {
        service: service as never,
        readJsonBody: vi.fn() as never,
        isMutationOriginAllowed: () => true,
      }),
    ).resolves.toBe(true);
    expect(response.statusCode).toBe(302);
    expect(headers.get("location")).toBe(`/platformclaw/app/settings/mcp?mcpOAuth=${result}`);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(cancelOAuth).toHaveBeenCalledTimes(url.includes("error=") ? 1 : 0);
  });

  it("redirects an expired browser session through login and back to OAuth recovery", async () => {
    const headers = new Map<string, string>();
    const response = {
      statusCode: 0,
      setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
      end: vi.fn(),
    } as unknown as ServerResponse;
    const request = {
      method: "GET",
      url: "/platformclaw/api/mcp/oauth/callback?state=state&code=code",
      headers: { cookie: "platformclaw_session=expired" },
    } as IncomingMessage;

    await handlePlatformClawEmployeeMcpRequest(request, response, {
      service: { authenticate: vi.fn(async () => null) } as never,
      readJsonBody: vi.fn() as never,
      isMutationOriginAllowed: () => true,
    });

    expect(response.statusCode).toBe(302);
    expect(headers.get("location")).toBe(
      "/platformclaw/login?returnTo=%2Fplatformclaw%2Fapp%2Fsettings%2Fmcp%3FmcpOAuth%3Derror",
    );
  });
});
