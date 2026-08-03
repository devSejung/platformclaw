import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { BrowserAuthService } from "./browser-auth-service.js";
import {
  handlePlatformClawMcpAdministrationRequest,
  McpAdministrationService,
  PLATFORMCLAW_MCP_ADMIN_PATH,
} from "./browser-mcp-admin-http.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";

function configSnapshot(config: Record<string, unknown> = {}) {
  return { config, hash: "config-hash" };
}

function createService(
  role: "member" | "admin",
  config: Record<string, unknown> = {},
  patchResult: unknown = configSnapshot(config),
) {
  const call = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "config.get") {
      return configSnapshot(config);
    }
    if (method === "agents.list") {
      return { agents: [{ id: "agent-two" }, { id: "agent-one" }] };
    }
    if (method === "config.patch") {
      return patchResult;
    }
    return { ok: true };
  });
  const authService = {
    authenticateToken: vi.fn(async () => ({
      status: "active",
      user: { id: "user-one", globalRole: role },
    })),
  } as unknown as BrowserAuthService;
  return {
    service: new McpAdministrationService({
      authService,
      adminRpc: { call } as unknown as GatewayAdminRpc,
    }),
    call,
  };
}

function responseHarness() {
  let body = "";
  return {
    response: {
      statusCode: 200,
      setHeader: vi.fn(),
      end: (value?: unknown) => {
        body = typeof value === "string" ? value : "";
      },
    } as unknown as ServerResponse,
    body: () => JSON.parse(body) as unknown,
  };
}

describe("MCP administration HTTP", () => {
  it("rejects members before reading Gateway configuration", async () => {
    const { service, call } = createService("member");
    const harness = responseHarness();

    await handlePlatformClawMcpAdministrationRequest(
      {
        url: PLATFORMCLAW_MCP_ADMIN_PATH,
        method: "GET",
        headers: { cookie: "platformclaw_session=test-token" },
      } as IncomingMessage,
      harness.response,
      { service, readJsonBody: vi.fn(), isMutationOriginAllowed: () => true },
    );

    expect(harness.response.statusCode).toBe(403);
    expect(harness.body()).toEqual({ error: "administrator access required" });
    expect(call).not.toHaveBeenCalled();
  });

  it("projects credential-free, shared, and personal policies without secrets", async () => {
    const { service } = createService("admin", {
      mcp: {
        servers: {
          public: { url: "https://public.example/mcp", transport: "streamable-http" },
          shared: {
            url: "https://shared.example/mcp",
            headers: { Authorization: "***" },
          },
          personal: {
            url: "https://personal.example/mcp",
            toolFilter: { exclude: ["delete_* ", "admin"] },
          },
        },
      },
      plugins: {
        entries: {
          "platformclaw-user-mcp": {
            config: { servers: { personal: { auth: "oauth", scope: "read" } } },
          },
        },
      },
    });

    await expect(service.snapshot()).resolves.toEqual({
      servers: [
        expect.objectContaining({
          name: "personal",
          credentialMode: "personal",
          personalAuth: "oauth",
        }),
        expect.objectContaining({ name: "public", credentialMode: "none" }),
        expect.objectContaining({ name: "shared", credentialMode: "shared" }),
      ],
    });
    expect(JSON.stringify(await service.snapshot())).not.toContain("***");
  });

  it("registers a credential-free server with every tool allowed by default", async () => {
    const { service, call } = createService("admin");

    await service.mutate("save-server", {
      name: "docs",
      url: "https://docs.example/mcp",
      transport: "streamable-http",
      credentialMode: "none",
      blockedTools: [],
      enabled: true,
    });

    expect(call).toHaveBeenNthCalledWith(2, "agents.list", {});
    expect(call).toHaveBeenNthCalledWith(3, "platformclaw-user-mcp.invalidateAgent", {
      agentId: "agent-one",
    });
    expect(call).toHaveBeenNthCalledWith(4, "platformclaw-user-mcp.invalidateAgent", {
      agentId: "agent-two",
    });
    expect(call).toHaveBeenNthCalledWith(5, "config.patch", {
      raw: JSON.stringify({
        mcp: {
          servers: {
            docs: {
              url: "https://docs.example/mcp",
              transport: "streamable-http",
              enabled: null,
              command: null,
              args: null,
              env: null,
              cwd: null,
              auth: null,
              oauth: null,
              toolFilter: null,
              headers: null,
            },
          },
        },
        plugins: {
          entries: { "platformclaw-user-mcp": { config: { servers: { docs: null } } } },
        },
      }),
      baseHash: "config-hash",
      note: "PlatformClaw MCP administration: save-server docs",
    });
    expect(call).toHaveBeenNthCalledWith(6, "agents.list", {});
    expect(call).toHaveBeenNthCalledWith(7, "platformclaw-user-mcp.invalidateAgent", {
      agentId: "agent-one",
    });
    expect(call).toHaveBeenNthCalledWith(8, "platformclaw-user-mcp.invalidateAgent", {
      agentId: "agent-two",
    });
  });

  it("stores only personal policy metadata for per-user credentials", async () => {
    const { service, call } = createService("admin");

    await service.mutate("save-server", {
      name: "github",
      url: "https://github.example/mcp",
      transport: "sse",
      credentialMode: "personal",
      auth: "api_key",
      headerName: "X-User-Key",
      blockedTools: ["delete_*"],
    });

    const patchRequest = call.mock.calls[4]?.[1] as { raw?: unknown } | undefined;
    if (!patchRequest) {
      throw new Error("missing config.patch request");
    }
    const patch = JSON.parse(String(patchRequest.raw)) as Record<string, unknown>;
    expect(patch).toMatchObject({
      mcp: {
        servers: {
          github: {
            headers: null,
            toolFilter: { exclude: ["delete_*"] },
          },
        },
      },
      plugins: {
        entries: {
          "platformclaw-user-mcp": {
            config: {
              servers: {
                github: { auth: "api_key", headerName: "X-User-Key", scope: null },
              },
            },
          },
        },
      },
    });
  });

  it("allows header credentials over plaintext HTTP", async () => {
    const { service, call } = createService("admin");

    await service.mutate("save-server", {
      name: "intranet",
      url: "http://mcp.example/mcp",
      transport: "sse",
      credentialMode: "shared",
      auth: "bearer",
      secret: "secret",
      blockedTools: [],
    });

    const patchRequest = call.mock.calls[4]?.[1] as { raw?: unknown } | undefined;
    expect(JSON.parse(String(patchRequest?.raw))).toMatchObject({
      mcp: {
        servers: {
          intranet: {
            url: "http://mcp.example/mcp",
            headers: { Authorization: "Bearer secret" },
          },
        },
      },
    });
  });

  it("keeps OAuth servers on HTTPS", async () => {
    const { service, call } = createService("admin");

    await expect(
      service.mutate("save-server", {
        name: "unsafe-oauth",
        url: "http://mcp.example/mcp",
        transport: "streamable-http",
        credentialMode: "personal",
        auth: "oauth",
        blockedTools: [],
      }),
    ).rejects.toThrow("OAuth servers must use HTTPS");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects URL-embedded credentials independently of credential mode", async () => {
    const { service, call } = createService("admin");

    await expect(
      service.mutate("save-server", {
        name: "unsafe",
        url: "http://mcp.example/mcp?api_key=secret",
        transport: "sse",
        credentialMode: "none",
        blockedTools: [],
      }),
    ).rejects.toThrow("must not embed credentials");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("keeps redacted credential-bearing URLs CLI-managed", async () => {
    const { service } = createService("admin", {
      mcp: { servers: { legacy: { url: "__OPENCLAW_REDACTED__" } } },
    });

    await expect(service.snapshot()).resolves.toEqual({
      servers: [
        expect.objectContaining({
          name: "legacy",
          target: "",
          transport: "invalid",
          editable: false,
        }),
      ],
    });
  });

  it("keeps servers with advanced TLS configuration CLI-managed", async () => {
    const config = {
      mcp: {
        servers: {
          private: { url: "https://private.example/mcp", sslVerify: false },
        },
      },
    };
    const { service } = createService("admin", config);

    await expect(service.snapshot()).resolves.toEqual({
      servers: [expect.objectContaining({ name: "private", editable: false })],
    });
    await expect(
      service.mutate("save-server", {
        name: "private",
        url: "https://private.example/mcp",
        transport: "sse",
        credentialMode: "shared",
        auth: "bearer",
        secret: "secret",
        blockedTools: [],
      }),
    ).rejects.toThrow("must be edited with the server CLI");
  });

  it("protects CLI-managed tool allowlists from browser edits", async () => {
    const config = {
      mcp: {
        servers: {
          restricted: {
            url: "https://restricted.example/mcp",
            toolFilter: { include: ["read_*"] },
          },
        },
      },
    };
    const { service, call } = createService("admin", config);

    await expect(service.snapshot()).resolves.toEqual({
      servers: [
        expect.objectContaining({
          name: "restricted",
          editable: false,
          toolPolicy: "allowlist",
        }),
      ],
    });
    await expect(
      service.mutate("save-server", {
        name: "restricted",
        url: "https://restricted.example/mcp",
        transport: "sse",
        credentialMode: "none",
        blockedTools: [],
      }),
    ).rejects.toThrow("must be edited with the server CLI");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("accepts a successful hashless no-op write response", async () => {
    const config = {
      mcp: { servers: { docs: { url: "https://docs.example/mcp" } } },
    };
    const { service } = createService("admin", config, { ok: true, noop: true, config });

    await expect(service.mutate("toggle-server", { name: "docs", enabled: true })).resolves.toEqual(
      {
        servers: [expect.objectContaining({ name: "docs", enabled: true })],
      },
    );
  });

  it("removes both the global server and its personal policy", async () => {
    const { service, call } = createService("admin", {
      mcp: { servers: { docs: { url: "https://docs.example/mcp" } } },
    });

    await service.mutate("remove-server", { name: "docs" });

    const request = call.mock.calls[4]?.[1] as { raw: string };
    expect(JSON.parse(request.raw)).toEqual({
      mcp: { servers: { docs: null } },
      plugins: {
        entries: { "platformclaw-user-mcp": { config: { servers: { docs: null } } } },
      },
    });
  });

  it("retries an already-committed removal through connection invalidation", async () => {
    const { service, call } = createService("admin");

    await expect(service.mutate("remove-server", { name: "docs" })).resolves.toEqual({
      servers: [],
    });
    expect(call).toHaveBeenNthCalledWith(2, "agents.list", {});
    expect(call).toHaveBeenNthCalledWith(5, "config.patch", expect.any(Object));
    expect(call).toHaveBeenNthCalledWith(6, "agents.list", {});
  });
});
