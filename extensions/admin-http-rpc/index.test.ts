// Admin Http Rpc tests cover index plugin behavior.
import { createServer } from "node:http";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { PLATFORMCLAW_PRODUCT_SYSTEM_CONTEXT } from "./src/product-identity.js";

type PluginApi = Parameters<typeof plugin.register>[0];
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), lookup: vi.fn() }));
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: mocks.lookup,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: mocks.fetch,
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("admin-http-rpc plugin entry", () => {
  const validateConfig = (value: unknown) =>
    validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "admin-http-rpc.timeout-contract",
      value,
      applyDefaults: true,
    });

  it("defaults the inference timeout while retaining explicit server opt-in", () => {
    expect(validateConfig({})).toEqual({
      ok: true,
      value: { composerPredictionsEnabled: false, composerPredictionsTimeoutMs: 30_000 },
    });
    expect(validateConfig({ composerPredictionsEnabled: true })).toEqual({
      ok: true,
      value: { composerPredictionsEnabled: true, composerPredictionsTimeoutMs: 30_000 },
    });
  });

  it.each([1_000, 300_000])("accepts the configured timeout boundary %i", (timeoutMs) => {
    expect(validateConfig({ composerPredictionsTimeoutMs: timeoutMs })).toEqual({
      ok: true,
      value: { composerPredictionsEnabled: false, composerPredictionsTimeoutMs: timeoutMs },
    });
  });

  it.each([999, 300_001, 1_000.5, "30000"])("rejects an invalid timeout %j", (timeoutMs) => {
    expect(validateConfig({ composerPredictionsTimeoutMs: timeoutMs }).ok).toBe(false);
  });

  it("stays startup-off until the plugin entry is explicitly enabled", () => {
    expect(manifest.activation).toEqual({
      onStartup: false,
      onConfigPaths: ["plugins.entries.admin-http-rpc"],
    });
    expect(manifest.contracts).toEqual({
      gatewayMethodDispatch: ["authenticated-request"],
    });
  });

  it("registers one trusted gateway HTTP route and stable product identity", async () => {
    const routes: Array<Record<string, unknown>> = [];
    const gatewayMethods: Array<{ method: string; options: unknown }> = [];
    const hooks: string[] = [];
    let beforeToolCall:
      | ((event: { toolName: string }, context: { agentId: string }) => unknown)
      | undefined;
    const stores: unknown[] = [];
    const profileStore: { value?: unknown } = {};
    const beforePromptBuild: Array<
      (
        event: unknown,
        context: { agentId?: string },
      ) => Record<string, string> | Promise<Record<string, string> | undefined> | undefined
    > = [];
    plugin.register({
      runtime: {
        state: {
          openKeyedStore(options: Parameters<PluginApi["runtime"]["state"]["openKeyedStore"]>[0]) {
            stores.push(options);
            return {
              update: async () => true,
              lookup: async () => profileStore.value,
            };
          },
        },
      },
      registerHttpRoute(route: Parameters<PluginApi["registerHttpRoute"]>[0]) {
        routes.push(route as unknown as Record<string, unknown>);
      },
      registerGatewayMethod(
        method: Parameters<PluginApi["registerGatewayMethod"]>[0],
        _handler: Parameters<PluginApi["registerGatewayMethod"]>[1],
        options: Parameters<PluginApi["registerGatewayMethod"]>[2],
      ) {
        gatewayMethods.push({ method, options });
      },
      on(hook: Parameters<PluginApi["on"]>[0], handler: unknown) {
        hooks.push(hook);
        if (hook === "before_tool_call") {
          beforeToolCall = handler as typeof beforeToolCall;
        }
        if (hook === "before_prompt_build") {
          beforePromptBuild.push(handler as (typeof beforePromptBuild)[number]);
        }
      },
    } as unknown as Parameters<typeof plugin.register>[0]);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      path: "/api/v1/admin/rpc",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
    });
    expect(gatewayMethods).toEqual([
      { method: "platformclaw.space.ensureAgent", options: { scope: "operator.admin" } },
      { method: "platformclaw.agent.configStatus", options: { scope: "operator.admin" } },
      { method: "platformclaw.profile.seed", options: { scope: "operator.admin" } },
      { method: "platformclaw.profile.status", options: { scope: "operator.admin" } },
    ]);
    expect(hooks).toEqual([
      "model_call_started",
      "model_call_ended",
      "before_tool_call",
      "before_prompt_build",
    ]);
    const sharedAgent = "space-12345678-1234-1234-1234-123456789abc";
    expect(beforeToolCall?.({ toolName: "exec" }, { agentId: sharedAgent })).toMatchObject({
      block: true,
    });
    expect(beforeToolCall?.({ toolName: "memory_search" }, { agentId: sharedAgent })).toMatchObject(
      { block: true },
    );
    expect(
      beforeToolCall?.({ toolName: "space_search" }, { agentId: sharedAgent }),
    ).toBeUndefined();
    expect(beforeToolCall?.({ toolName: "exec" }, { agentId: "person-alice" })).toBeUndefined();
    expect(stores).toEqual([
      {
        namespace: "platformclaw.composer-preferences",
        maxEntries: 50_000,
        overflowPolicy: "reject-new",
      },
      {
        namespace: "platformclaw.employee-profiles",
        maxEntries: 50_000,
        overflowPolicy: "reject-new",
      },
    ]);
    expect(PLATFORMCLAW_PRODUCT_SYSTEM_CONTEXT).toBe(
      "Host product: PlatformClaw. Call it PlatformClaw; preserve agent identity. OpenClaw names mean runtime and CLI/API/package/path/config compatibility only.",
    );
    expect(Buffer.byteLength(PLATFORMCLAW_PRODUCT_SYSTEM_CONTEXT, "utf8")).toBeLessThanOrEqual(160);
    await expect(Promise.resolve(beforePromptBuild[0]?.({}, {}))).resolves.toEqual({
      appendSystemContext: PLATFORMCLAW_PRODUCT_SYSTEM_CONTEXT,
    });

    profileStore.value = {
      schema: "platformclaw.employee-profile.v1",
      profile: {
        employeeId: "employee-1",
        groups: [],
        attributes: {},
      },
    };
    await expect(
      Promise.resolve(beforePromptBuild[0]?.({}, { agentId: "employee-1" })),
    ).resolves.toMatchObject({
      appendSystemContext: PLATFORMCLAW_PRODUCT_SYSTEM_CONTEXT,
      prependContext: expect.stringContaining('"employeeId": "employee-1"'),
    });
  });

  it("routes ordinary model lifecycle hooks to HTTP prediction admission", async () => {
    vi.stubEnv("PLATFORMCLAW_COMPOSER_PREDICTIONS_MODEL", "codemate/codellm-fast");
    const routes: Array<Parameters<PluginApi["registerHttpRoute"]>[0]> = [];
    const hooks = new Map<string, (event: { callId: string }) => unknown>();
    const stores = new Map<string, Map<string, unknown>>();
    plugin.register({
      runtime: {
        config: {
          current: () => ({
            plugins: {
              entries: {
                "admin-http-rpc": {
                  config: {
                    composerPredictionsEnabled: true,
                    composerPredictionsTimeoutMs: 45_000,
                  },
                },
              },
            },
            models: {
              providers: {
                codemate: {
                  api: "openai-completions",
                  baseUrl: "http://company.internal/v1",
                  models: [{ id: "codellm-fast" }],
                },
              },
            },
          }),
        },
        state: {
          openKeyedStore({ namespace }: { namespace: string }) {
            const values = new Map<string, unknown>();
            stores.set(namespace, values);
            return {
              lookup: async (key: string) => values.get(key),
              register: async (key: string, value: unknown) => values.set(key, value),
            };
          },
        },
      },
      registerHttpRoute: (route: Parameters<PluginApi["registerHttpRoute"]>[0]) =>
        routes.push(route),
      registerGatewayMethod: () => {},
      on: (name: Parameters<PluginApi["on"]>[0], handler: unknown) =>
        hooks.set(name, handler as (event: { callId: string }) => unknown),
    } as unknown as PluginApi);
    const route = routes[0];
    if (!route) {
      throw new Error("Admin HTTP route was not registered");
    }
    const server = createServer((req, res) => {
      void Promise.resolve(route.handler(req, res)).catch(() => res.destroy());
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Admin HTTP test listener has no address");
      }
      const post = async (params: unknown) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/admin/rpc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "platformclaw.composer", params }),
        });
        expect(response.ok).toBe(true);
        return response.json();
      };
      expect(await post({ action: "preferences", userId: "user-1", enabled: true })).toEqual({
        id: expect.any(String),
        ok: true,
        payload: { available: true, enabled: true, timeoutMs: 45_000 },
      });
      expect(stores.get("platformclaw.composer-preferences")?.get("user-1")).toBe(true);
      expect(stores.get("platformclaw.employee-profiles")?.has("user-1")).toBe(false);
      mocks.lookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
      mocks.fetch.mockResolvedValue({
        response: Response.json({ choices: [{ message: { content: "다음 단계는 무엇인가요?" } }] }),
        release: async () => {},
      });
      let upstreamSignal: AbortSignal | undefined;
      mocks.fetch.mockImplementationOnce(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            upstreamSignal = signal;
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      );
      const params = {
        action: "predict",
        userId: "user-1",
        messages: [
          { role: "user", content: "계획" },
          { role: "assistant", content: "답변" },
        ],
      };
      const prediction = post(params);
      await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
      hooks.get("model_call_started")?.({ callId: "ordinary-chat" });
      expect(upstreamSignal?.aborted).toBe(true);
      expect(await prediction).toMatchObject({ ok: true, payload: { text: null } });
      expect(await post(params)).toMatchObject({ ok: true, payload: { text: null } });
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      hooks.get("model_call_ended")?.({ callId: "ordinary-chat" });
      expect(await post(params)).toMatchObject({
        ok: true,
        payload: { text: "다음 단계는 무엇인가요?" },
      });
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
