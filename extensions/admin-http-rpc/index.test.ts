// Admin Http Rpc tests cover index plugin behavior.
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { PLATFORMCLAW_PRODUCT_SYSTEM_CONTEXT } from "./src/product-identity.js";

type PluginApi = Parameters<typeof plugin.register>[0];

describe("admin-http-rpc plugin entry", () => {
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
      { method: "platformclaw.agent.configStatus", options: { scope: "operator.admin" } },
      { method: "platformclaw.profile.seed", options: { scope: "operator.admin" } },
      { method: "platformclaw.profile.status", options: { scope: "operator.admin" } },
    ]);
    expect(hooks).toEqual(["before_prompt_build", "before_prompt_build"]);
    expect(stores).toEqual([
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
    await expect(Promise.resolve(beforePromptBuild[1]?.({}, {}))).resolves.toBeUndefined();

    profileStore.value = {
      schema: "platformclaw.employee-profile.v1",
      profile: {
        employeeId: "employee-1",
        groups: [],
        attributes: {},
      },
    };
    await expect(
      Promise.resolve(beforePromptBuild[1]?.({}, { agentId: "employee-1" })),
    ).resolves.toMatchObject({
      prependContext: expect.stringContaining('"employeeId": "employee-1"'),
    });
  });
});
