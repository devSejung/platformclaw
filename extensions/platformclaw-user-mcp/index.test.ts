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

function registerPlugin(auth: "bearer" | "oauth" = "bearer") {
  let config = serverConfig("https://mcp.example.test/initial");
  const current = vi.fn(() => config);
  const resolvers = new Map<string, McpResolver>();
  const handlers = new Map<string, GatewayHandler>();
  const api = {
    registrationMode: "full",
    config,
    pluginConfig: { servers: { private: { auth } } },
    runtime: { config: { current } },
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
    replaceConfig(next: OpenClawConfig) {
      config = next;
    },
    resolve: () => resolvers.get("private")!.resolveForAgent!({ agentId: "agent-one" }),
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
      headers: { Authorization: "Bearer fixture-token" },
    });
    expect(mocks.resolve).toHaveBeenCalledWith(
      "agent-one",
      "private",
      "https://mcp.example.test/current",
    );
    const respond = await registered.catalog(serverConfig("https://mcp.example.test/request"));
    expect(respond).toHaveBeenCalledWith(true, {
      servers: [{ serverName: "private", auth: "bearer", url: "https://mcp.example.test/request" }],
    });
    expect(registered.current).toHaveBeenCalledTimes(1);
    expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
  });

  it("pins the selected URL while awaiting its credential response", async () => {
    const registered = registerPlugin();
    const selectedUrl = "https://mcp.example.test/selected";
    registered.replaceConfig(serverConfig(selectedUrl));
    let complete!: (connection: Awaited<ReturnType<typeof mocks.resolve>>) => void;
    mocks.resolve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );

    const pending = registered.resolve();
    registered.replaceConfig(serverConfig("https://mcp.example.test/later"));
    complete({ headers: { Authorization: "Bearer selected-token" }, expiresAt: 123_456 });

    expect(await pending).toEqual({
      url: selectedUrl,
      headers: { Authorization: "Bearer selected-token" },
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
});
