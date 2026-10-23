/** Declaration changes and late work cross the real session-manager boundary. */
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../config/types.mcp.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.js";
import {
  DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import type { McpToolCatalog, SessionMcpRuntimeManager } from "./agent-bundle-mcp-types.js";
import {
  testing as resolverTesting,
  type McpServerConnectionResolved,
} from "./mcp-connection-resolver.js";

type CreateParams = Parameters<CreateSessionMcpRuntime>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function config(
  url = "https://declared.example.test/one",
  server: McpServerConfig = {},
): OpenClawConfig {
  return {
    plugins: { enabled: false },
    mcp: { servers: { personal: { url, transport: "streamable-http", ...server } } },
  };
}

const managers: SessionMcpRuntimeManager[] = [];

function createHarness(
  loadCatalog?: (catalog: McpToolCatalog, params: CreateParams) => Promise<McpToolCatalog>,
) {
  let now = 1_000_000;
  let token = "first-user-token";
  const resolve = vi.fn(
    async ({
      requesterSenderId,
    }: {
      requesterSenderId: string;
    }): Promise<McpServerConnectionResolved | null> =>
      requesterSenderId === "guest"
        ? null
        : {
            url: `https://resolved.example.test/${requesterSenderId}`,
            headers: { Authorization: `Bearer ${token}` },
          },
  );
  resolverTesting.setMcpServerConnectionResolversForTest([{ serverName: "personal", resolve }]);
  const createRuntime = vi.fn<CreateSessionMcpRuntime>((params) => {
    let lastUsedAt = now;
    const catalog: McpToolCatalog = {
      version: 1,
      generatedAt: now,
      servers: {
        personal: {
          serverName: "personal",
          safeServerName: "personal",
          launchSummary: "personal",
          toolCount: 1,
        },
      },
      tools: [
        {
          serverName: "personal",
          safeServerName: "personal",
          toolName: "read",
          inputSchema: Type.Object({}),
          fallbackDescription: "read",
        },
      ],
    };
    return {
      sessionId: params.sessionId,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      configFingerprint: params.configFingerprint!,
      requesterScope: params.requesterScope,
      createdAt: now,
      get lastUsedAt() {
        return lastUsedAt;
      },
      markUsed() {
        lastUsedAt = now;
      },
      getCatalog: () => (loadCatalog ? loadCatalog(catalog, params) : Promise.resolve(catalog)),
      peekCatalog: () => catalog,
      callTool: async () => ({ content: [] }),
      dispose: vi.fn(async () => {}),
    };
  });
  const manager = createSessionMcpRuntimeManager({
    createRuntime,
    now: () => now,
    enableIdleSweepTimer: false,
  });
  managers.push(manager);
  const params = {
    sessionId: "session",
    workspaceDir: "/workspace",
    manifestRegistry: { plugins: [] },
    cfg: config(),
  };
  return {
    manager,
    params,
    resolve,
    createRuntime,
    run: (overrides: Partial<Parameters<typeof manager.getOrCreateRequesterScoped>[0]> = {}) =>
      manager.getOrCreateRequesterScoped({ ...params, requesterSenderId: "alice", ...overrides }),
    rotateCredentials() {
      token = "rotated-user-token";
      now += 5 * 60_000 + 1;
    },
    expireConnections() {
      now += DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS + 1;
    },
  };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  resolverTesting.setMcpServerConnectionResolversForTest(null);
});

describe("scoped MCP declaration generations", () => {
  it.each([
    { name: "removed server", cfg: { plugins: { enabled: false }, mcp: { servers: {} } } },
    { name: "disabled server", cfg: config(undefined, { enabled: false }) },
    { name: "filter", cfg: config(undefined, { toolFilter: { exclude: ["read"] } }) },
    { name: "URL", cfg: config("https://declared.example.test/two") },
    { name: "headers", cfg: config(undefined, { headers: { "X-Route": "two" } }) },
  ])(
    "clears old advertisements for changed $name even when credentials are missing",
    async ({ cfg }) => {
      const harness = createHarness();
      const first = await harness.run();
      expect(harness.manager.getAdvertisedScopedCatalog("session")?.tools).toHaveLength(1);

      await expect(harness.run({ cfg, requesterSenderId: "guest" })).resolves.toBeUndefined();

      expect(harness.manager.getAdvertisedScopedCatalog("session")).toBeNull();
      expect(first!.dispose).toHaveBeenCalledTimes(1);
      expect(harness.manager.listRuntimeKeys()).toEqual([]);
    },
  );

  it("preserves schemas across missing credentials and unrelated model config changes", async () => {
    const harness = createHarness();
    const first = await harness.run();
    await harness.run({ requesterSenderId: "guest" });
    await harness.run({
      cfg: { ...config(), agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } } },
      requesterSenderId: undefined,
    });

    expect(
      harness.manager.getAdvertisedScopedCatalog("session")?.tools.map((tool) => tool.toolName),
    ).toEqual(["read"]);
    expect(first!.dispose).not.toHaveBeenCalled();
    expect(await harness.run()).toBe(first);
  });

  it.each(["url", "headers"] as const)(
    "revalidates immediately for a declared %s change",
    async (field) => {
      const harness = createHarness();
      const first = await harness.run();
      const cfg = field === "url" ? config("https://declared.example.test/two") : config();
      if (field === "headers") {
        cfg.mcp!.servers!.personal!.headers = { "X-Route": "two" };
      }
      const second = await harness.run({ cfg });

      expect(second).not.toBe(first);
      expect(harness.resolve).toHaveBeenCalledTimes(2);
      expect(first!.dispose).toHaveBeenCalledTimes(1);
      // Declaration identity is separate from credential-free public fingerprints.
      expect(first!.configFingerprint).toBe(second!.configFingerprint);
    },
  );

  it("rotates resolved credentials without invalidating the declared catalog", async () => {
    const harness = createHarness();
    const first = await harness.run();
    const bob = await harness.run({ requesterSenderId: "bob" });
    harness.rotateCredentials();
    const second = await harness.run();
    await harness.run({ requesterSenderId: "guest" });

    expect(second).not.toBe(first);
    expect(second!.configFingerprint).toBe(first!.configFingerprint);
    expect(bob!.dispose).not.toHaveBeenCalled();
    expect(harness.manager.getAdvertisedScopedCatalog("session")?.tools).toHaveLength(1);
  });

  it.each([false, true])(
    "retires an idle agent's cached catalog only when requested (%s)",
    async (retireSessionCatalog) => {
      const harness = createHarness();
      await harness.run({ agentId: "alice" });
      harness.expireConnections();
      expect(await harness.manager.sweepIdleRuntimes()).toBe(1);
      expect(harness.manager.listRuntimeKeys()).toEqual([]);
      expect(harness.manager.getAdvertisedScopedCatalog("session")?.tools).toHaveLength(1);

      await harness.manager.disposeAgentScoped("alice", { retireSessionCatalog });

      await expect(
        harness.run({ agentId: "alice", requesterSenderId: "guest" }),
      ).resolves.toBeUndefined();
      expect(harness.manager.getAdvertisedScopedCatalog("session")?.tools.length ?? 0).toBe(
        retireSessionCatalog ? 0 : 1,
      );
    },
  );

  it.each(["session", "all", "agent retirement"] as const)(
    "prevents a pending resolver from installing after %s disposal",
    async (scope) => {
      const harness = createHarness();
      const started = deferred<void>();
      const connection = deferred<Awaited<ReturnType<typeof harness.resolve>>>();
      harness.resolve.mockImplementationOnce(async () => {
        started.resolve(undefined);
        return await connection.promise;
      });
      const pending = harness.run({ agentId: "alice" });
      await started.promise;
      const disposing =
        scope === "session"
          ? harness.manager.disposeSession("session")
          : scope === "all"
            ? harness.manager.disposeAll()
            : harness.manager.disposeAgentScoped("alice", { retireSessionCatalog: true });
      connection.resolve({ url: "https://resolved.example.test/retired", headers: {} });

      await expect(pending).resolves.toBeUndefined();
      await disposing;
      expect(harness.createRuntime).not.toHaveBeenCalled();
      expect(harness.manager.listRuntimeKeys()).toEqual([]);
      expect(harness.manager.getAdvertisedScopedCatalog("session")).toBeNull();
    },
  );

  it("rejects a late resolver after definitions change away and back", async () => {
    const harness = createHarness();
    const started = deferred<void>();
    const connection = deferred<Awaited<ReturnType<typeof harness.resolve>>>();
    harness.resolve.mockImplementationOnce(async () => {
      started.resolve(undefined);
      return await connection.promise;
    });
    const oldRun = harness.run();
    await started.promise;
    await harness.run({
      cfg: config("https://declared.example.test/two"),
      requesterSenderId: undefined,
    });
    const current = await harness.run({ requesterSenderId: "bob" });
    connection.resolve({
      url: "https://resolved.example.test/retired",
      headers: { Authorization: "retired" },
    });

    await expect(oldRun).resolves.toBeUndefined();
    expect(harness.createRuntime).toHaveBeenCalledTimes(1);
    expect(harness.manager.listRuntimeKeys()).toHaveLength(1);
    expect(current!.dispose).not.toHaveBeenCalled();
  });

  it.each(["replacement", "session disposal", "all disposal", "agent retirement"] as const)(
    "does not publish a late catalog after %s",
    async (operation) => {
      const started = deferred<void>();
      const release = deferred<void>();
      const harness = createHarness(async (catalog, params) => {
        if (params.requesterScope?.requesterSenderId === "alice") {
          started.resolve(undefined);
          await release.promise;
        }
        return catalog;
      });
      const oldRun = harness.run({ agentId: "alice" });
      await started.promise;
      if (operation === "replacement") {
        await harness.run({
          cfg: config("https://declared.example.test/two"),
          requesterSenderId: "bob",
        });
      } else if (operation === "session disposal") {
        await harness.manager.disposeSession("session");
      } else if (operation === "all disposal") {
        await harness.manager.disposeAll();
      } else {
        await harness.manager.disposeAgentScoped("alice", { retireSessionCatalog: true });
      }
      release.resolve(undefined);

      await expect(oldRun).resolves.toBeUndefined();
      expect(harness.manager.listRuntimeKeys()).toHaveLength(operation === "replacement" ? 1 : 0);
      expect(harness.manager.getAdvertisedScopedCatalog("session")?.tools.length ?? 0).toBe(
        operation === "replacement" ? 1 : 0,
      );
    },
  );
});
