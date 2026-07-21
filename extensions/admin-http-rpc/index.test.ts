// Admin Http Rpc tests cover index plugin behavior.
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

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

  it("registers one trusted gateway HTTP route", () => {
    const routes: Array<Record<string, unknown>> = [];
    const gatewayMethods: Array<{ method: string; options: unknown }> = [];
    const hooks: string[] = [];
    const stores: unknown[] = [];
    plugin.register({
      runtime: {
        state: {
          openKeyedStore(options: Parameters<PluginApi["runtime"]["state"]["openKeyedStore"]>[0]) {
            stores.push(options);
            return {
              registerIfAbsent: async () => true,
              lookup: async () => undefined,
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
      on(hook: Parameters<PluginApi["on"]>[0]) {
        hooks.push(hook);
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
      { method: "platformclaw.profile.seed", options: { scope: "operator.admin" } },
      { method: "platformclaw.profile.status", options: { scope: "operator.admin" } },
    ]);
    expect(hooks).toEqual(["before_prompt_build"]);
    expect(stores).toEqual([
      {
        namespace: "platformclaw.employee-profiles",
        maxEntries: 50_000,
        overflowPolicy: "reject-new",
      },
    ]);
  });
});
