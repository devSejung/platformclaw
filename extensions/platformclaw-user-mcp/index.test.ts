import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin, { configuredRemoteUrl } from "./index.js";

const mocks = vi.hoisted(() => ({
  resolve:
    vi.fn<
      (
        agentId: string,
        serverName: string,
        serverUrl: string,
      ) => Promise<{ headers: Record<string, string>; expiresAt?: number } | null>
    >(),
  createRuntime: vi.fn(),
}));

vi.mock("./src/runtime.js", () => ({
  createUserMcpConnectionRuntime: mocks.createRuntime,
}));

type McpResolver = Parameters<OpenClawPluginApi["registerMcpServerConnectionResolver"]>[0];
type GatewayHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

function serverConfig(url: string): OpenClawConfig {
  return { mcp: { servers: { private: { url } } } };
}

function registerPlugin(
  auth: "bearer" | "oauth" = "bearer",
  options: { config?: OpenClawConfig; pluginConfig?: Record<string, unknown> } = {},
) {
  let config = options.config ?? serverConfig("https://mcp.example.test/initial");
  const current = vi.fn(() => config);
  const disposeAgentConnections = vi.fn(async () => 1);
  const resolvers = new Map<string, McpResolver>();
  const handlers = new Map<string, GatewayHandler>();
  const api = {
    registrationMode: "full",
    config,
    pluginConfig: options.pluginConfig ?? { servers: { private: { auth } } },
    runtime: { config: { current }, mcp: { disposeAgentConnections } },
    registerMcpServerConnectionResolver: (resolver: McpResolver) => {
      resolvers.set(resolver.serverName, resolver);
    },
    registerGatewayMethod: (method: string, handler: GatewayHandler) => {
      handlers.set(method, handler);
    },
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  return {
    current,
    resolvers,
    disposeAgentConnections,
    replaceConfig(next: OpenClawConfig) {
      config = next;
    },
    resolve: (serverName = "private", agentId = "agent-one") =>
      resolvers.get(serverName)!.resolveForAgent!({ agentId }),
    async invalidate(agentId: string) {
      const respond = vi.fn();
      await handlers.get("platformclaw-user-mcp.invalidateAgent")!({
        params: { agentId },
        respond,
      } as unknown as Parameters<GatewayHandler>[0]);
      return respond;
    },
    async catalog(requestConfig: OpenClawConfig) {
      const respond = vi.fn();
      await handlers.get("platformclaw-user-mcp.catalog")!({
        context: { getRuntimeConfig: () => requestConfig },
        respond,
      } as unknown as Parameters<GatewayHandler>[0]);
      return respond;
    },
  };
}

beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.resolve.mockResolvedValue({ headers: { Authorization: "Bearer fixture-token" } });
  mocks.createRuntime.mockReset();
  mocks.createRuntime.mockReturnValue({ resolve: mocks.resolve });
});

describe("configuredRemoteUrl", () => {
  it.each(["bearer", "api_key"] as const)(
    "allows personal %s credentials over administrator-approved HTTP",
    (auth) => {
      expect(
        configuredRemoteUrl(
          { mcp: { servers: { private: { url: "http://mcp.example.test" } } } },
          "private",
          auth,
        ),
      ).toBe("http://mcp.example.test/");
    },
  );

  it("keeps personal OAuth on HTTPS", () => {
    expect(() =>
      configuredRemoteUrl(
        { mcp: { servers: { private: { url: "http://mcp.example.test" } } } },
        "private",
        "oauth",
      ),
    ).toThrow("OAuth");
    expect(
      configuredRemoteUrl(
        { mcp: { servers: { private: { url: "https://mcp.example.test" } } } },
        "private",
        "oauth",
      ),
    ).toBe("https://mcp.example.test/");
  });
});

describe("registered MCP callbacks across config publication", () => {
  it("uses current resolver and request snapshots after registration", async () => {
    const registered = registerPlugin();
    registered.replaceConfig(serverConfig("https://mcp.example.test/current"));

    expect(await registered.resolve()).toMatchObject({
      url: "https://mcp.example.test/current",
      headers: { authorization: "Bearer fixture-token" },
    });
    expect(mocks.resolve).toHaveBeenCalledWith(
      "agent-one",
      "private",
      "https://mcp.example.test/current",
    );
    const respond = await registered.catalog(serverConfig("https://mcp.example.test/request"));
    expect(respond).toHaveBeenCalledWith(true, {
      servers: [
        {
          serverName: "private",
          credentialMode: "personal",
          auth: "bearer",
          headerGuides: [],
          url: "https://mcp.example.test/request",
          enabled: true,
          commonHeaderNames: [],
          configuredOAuth: false,
        },
      ],
    });
    expect(registered.current).toHaveBeenCalledTimes(1);
    expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
  });

  it("pins the selected URL while awaiting its credential response", async () => {
    const registered = registerPlugin();
    const selectedUrl = "https://mcp.example.test/selected";
    registered.replaceConfig({
      mcp: { servers: { private: { url: selectedUrl, headers: { "X-Route": "selected" } } } },
    });
    let complete!: (connection: Awaited<ReturnType<typeof mocks.resolve>>) => void;
    mocks.resolve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );

    const pending = registered.resolve();
    registered.replaceConfig({
      mcp: {
        servers: {
          private: { url: "https://mcp.example.test/later", headers: { "X-Route": "later" } },
        },
      },
    });
    complete({ headers: { Authorization: "Bearer selected-token" }, expiresAt: 123_456 });

    expect(await pending).toEqual({
      url: selectedUrl,
      headers: { authorization: "Bearer selected-token", "x-route": "selected" },
      expiresAt: 123_456,
    });
    expect(mocks.resolve).toHaveBeenCalledWith("agent-one", "private", selectedUrl);
    expect(registered.current).toHaveBeenCalledTimes(1);
  });

  it.each([
    { auth: "bearer" as const, config: serverConfig("file:///private"), error: "HTTP(S)" },
    { auth: "bearer" as const, config: {}, error: "not declared" },
    { auth: "oauth" as const, config: serverConfig("http://mcp.example.test"), error: "HTTPS" },
  ])("rejects invalid current $auth definitions without an old-URL fallback", async (testCase) => {
    const registered = registerPlugin(testCase.auth);
    registered.replaceConfig(testCase.config);

    await expect(registered.resolve()).rejects.toThrow(testCase.error);
    await expect(registered.catalog(testCase.config)).rejects.toThrow(testCase.error);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("adopts common remote declarations across none/shared/personal modes without taking stdio", async () => {
    const registered = registerPlugin("bearer", {
      config: {
        mcp: {
          servers: {
            public: { url: "https://mcp.example.test/public" },
            shared: {
              url: "https://mcp.example.test/shared",
              headers: { Authorization: "Bearer common-secret" },
            },
            private: { url: "https://mcp.example.test/private" },
            stdio: { command: "node", args: ["server.mjs"] },
            commandWins: { command: "node", url: "https://mcp.example.test/not-remote" },
          },
        },
      },
    });
    expect([...registered.resolvers.keys()].toSorted()).toEqual(["private", "public", "shared"]);
    const respond = await registered.catalog({
      mcp: {
        servers: {
          public: { url: "https://mcp.example.test/public" },
          shared: {
            url: "https://mcp.example.test/shared",
            headers: { Authorization: "Bearer common-secret" },
          },
          private: { url: "https://mcp.example.test/private" },
        },
      },
    });
    expect(respond.mock.calls[0]?.[1]?.servers).toEqual([
      expect.objectContaining({ serverName: "private", credentialMode: "personal" }),
      expect.objectContaining({ serverName: "public", credentialMode: "none" }),
      expect.objectContaining({ serverName: "shared", credentialMode: "shared" }),
    ]);
  });

  it.each(["none", "shared", "personal"] as const)(
    "enforces organization Off before credential resolution for %s servers",
    async (credentialMode) => {
      const registered = registerPlugin("bearer", {
        pluginConfig: {
          servers: {
            private: {
              credentialMode,
              ...(credentialMode === "personal" ? { auth: "bearer" } : {}),
            },
          },
        },
      });
      registered.replaceConfig({
        mcp: { servers: { private: { url: "https://mcp.example.test/off", enabled: false } } },
      });
      // Resolve the registered route directly, as a session enable override would.
      expect(await registered.resolve()).toBeNull();
      expect(mocks.resolve).not.toHaveBeenCalled();
    },
  );

  it.each(["none", "shared", "personal"] as const)(
    "never falls back to static headers when the %s broker resolution is unavailable",
    async (credentialMode) => {
      const registered = registerPlugin("bearer", {
        config: {
          mcp: {
            servers: {
              private: {
                url: "https://mcp.example.test/static",
                headers: { Authorization: "Bearer static-secret" },
              },
            },
          },
        },
        pluginConfig: {
          servers: {
            private: {
              credentialMode,
              ...(credentialMode === "personal" ? { auth: "bearer" } : {}),
            },
          },
        },
      });
      mocks.resolve.mockResolvedValueOnce(null);
      expect(await registered.resolve()).toBeNull();
      mocks.resolve.mockRejectedValueOnce(new Error("credential broker unavailable"));
      await expect(registered.resolve()).rejects.toThrow("credential broker unavailable");
    },
  );

  it("composes current common headers and broker headers case-insensitively", async () => {
    const config: OpenClawConfig = {
      mcp: {
        servers: {
          private: {
            url: "https://mcp.example.test/headers",
            headers: { "X-Tenant": "common", "X-Common": "retained", authorization: "old" },
          },
        },
      },
    };
    const registered = registerPlugin("bearer", { config });
    mocks.resolve.mockResolvedValueOnce({
      headers: { "x-tenant": "employee", "X-User": "user-value", Authorization: "Bearer fresh" },
    });
    expect(await registered.resolve()).toMatchObject({
      headers: {
        "x-tenant": "employee",
        "x-common": "retained",
        "x-user": "user-value",
        authorization: "Bearer fresh",
      },
    });
    expect(config.mcp!.servers!.private!.headers).toEqual({
      "X-Tenant": "common",
      "X-Common": "retained",
      authorization: "old",
    });
  });

  it("preserves configured shared OAuth and publishes header names without their secret values", async () => {
    const config: OpenClawConfig = {
      mcp: {
        servers: {
          private: {
            url: "https://mcp.example.test/oauth",
            auth: "oauth",
            oauth: { scope: "docs" },
            headers: { "X-Tenant": "common-private-value" },
          },
        },
      },
    };
    const registered = registerPlugin("bearer", { config, pluginConfig: {} });
    mocks.resolve.mockResolvedValueOnce({ headers: { "X-Employee": "private-user-value" } });
    expect(await registered.resolve()).toMatchObject({
      preserveConfiguredAuth: true,
      headers: { "x-tenant": "common-private-value", "x-employee": "private-user-value" },
    });
    const respond = await registered.catalog(config);
    expect(respond.mock.calls[0]?.[1]?.servers).toEqual([
      expect.objectContaining({
        credentialMode: "shared",
        commonHeaderNames: ["X-Tenant"],
        configuredOAuth: true,
      }),
    ]);
    expect(JSON.stringify(respond.mock.calls)).not.toContain("common-private-value");
    expect(JSON.stringify(respond.mock.calls)).not.toContain("private-user-value");
  });

  it("invalidates full agent catalogs for preference and credential changes", async () => {
    const registered = registerPlugin();
    expect(await registered.invalidate(" agent-one ")).toHaveBeenCalledWith(true, { disposed: 1 });
    expect(registered.disposeAgentConnections).toHaveBeenCalledWith({
      agentId: "agent-one",
      retireSessionCatalog: true,
    });
  });

  it("sends headers from the real credential broker through the registered resolver onto MCP requests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "user-mcp-wire-"));
    const brokerAddress =
      process.platform === "win32"
        ? `\\\\.\\pipe\\user-mcp-${randomUUID()}`
        : path.join(root, "credential.sock");
    const executionAddress =
      process.platform === "win32"
        ? `${brokerAddress}-execution`
        : path.join(root, "execution.sock");
    const tokenFile = path.join(root, "execution-token");
    await fs.writeFile(tokenFile, "fixture-service-token", { mode: 0o600 });
    const brokerRequests: Array<{ authorization?: string; pathname?: string; body: unknown }> = [];
    const broker = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.once("end", () => {
        brokerRequests.push({
          authorization: req.headers.authorization,
          pathname: req.url,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            headers: {
              Authorization: "Bearer personal-wire-token",
              "x-tenant": "employee-tenant",
              "X-Employee": "employee-one",
            },
          }),
        );
      });
    });
    const wireHeaders: http.IncomingHttpHeaders[] = [];
    const mcp = new McpServer({ name: "user-mcp-wire", version: "1" });
    mcp.registerTool("header_probe", {}, async () => ({
      content: [{ type: "text", text: "wire-ok" }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await mcp.connect(transport);
    const resource = http.createServer((req, res) => {
      wireHeaders.push(req.headers);
      if (
        req.headers.authorization !== "Bearer personal-wire-token" ||
        req.headers["x-common"] !== "retained" ||
        req.headers["x-tenant"] !== "employee-tenant" ||
        req.headers["x-employee"] !== "employee-one"
      ) {
        res.writeHead(401).end();
        return;
      }
      void transport.handleRequest(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500).end();
        }
      });
    });
    const client = new Client({ name: "user-mcp-wire-client", version: "1" });
    const closeServer = async (server: http.Server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    };
    try {
      await new Promise<void>((resolve) => {
        broker.listen(executionAddress, resolve);
      });
      await new Promise<void>((resolve) => {
        resource.listen(0, "127.0.0.1", resolve);
      });
      const address = resource.address();
      if (!address || typeof address === "string") {
        throw new Error("MCP server did not bind");
      }
      const url = `http://127.0.0.1:${address.port}/mcp`;
      const runtime = await vi.importActual<typeof import("./src/runtime.js")>("./src/runtime.js");
      mocks.createRuntime.mockImplementationOnce(() =>
        runtime.createUserMcpConnectionRuntime({
          PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS: brokerAddress,
          PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE: tokenFile,
        }),
      );
      const registered = registerPlugin("bearer", {
        config: {
          mcp: {
            servers: {
              private: {
                url,
                transport: "streamable-http",
                headers: { "X-Common": "retained", "X-Tenant": "common-tenant" },
              },
            },
          },
        },
      });
      const connection = await registered.resolve();
      expect(connection).not.toBeNull();
      await client.connect(
        new StreamableHTTPClientTransport(new URL(connection!.url), {
          requestInit: { headers: connection!.headers },
        }),
      );
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["header_probe"]);
      expect(await client.callTool({ name: "header_probe", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "wire-ok" }],
      });
      expect(brokerRequests).toEqual([
        {
          authorization: "Bearer fixture-service-token",
          pathname: "/platformclaw/internal/mcp/connection",
          body: { agentId: "agent-one", serverName: "private", serverUrl: url },
        },
      ]);
      expect(wireHeaders.length).toBeGreaterThanOrEqual(3);
      for (const headers of wireHeaders) {
        expect(headers).toMatchObject({
          authorization: "Bearer personal-wire-token",
          "x-common": "retained",
          "x-tenant": "employee-tenant",
          "x-employee": "employee-one",
        });
      }
    } finally {
      await client.close();
      await mcp.close();
      await Promise.all([closeServer(resource), closeServer(broker)]);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
