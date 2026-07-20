import type { GatewayClientOptions } from "@openclaw/gateway-client";
import type { HelloOk } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { createPlatformClawWebIngressRuntime } from "./web-ingress-runtime.js";

function hello(): HelloOk {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "test", connId: "private" },
    features: { methods: [], events: [] },
    snapshot: {
      presence: [],
      health: {},
      stateVersion: { presence: 1, health: 1 },
      uptimeMs: 10,
    },
    auth: { role: "operator", scopes: ["operator.admin"] },
    policy: { maxPayload: 1_024, maxBufferedBytes: 2_048, tickIntervalMs: 30_000 },
  };
}

describe("createPlatformClawWebIngressRuntime", () => {
  it("assembles employee auth, the private Gateway, policy proxy, and listener", async () => {
    let clientOptions: GatewayClientOptions | undefined;
    const stop = vi.fn();
    const provisionOrRefresh = vi.fn(async () => undefined);
    const runtime = createPlatformClawWebIngressRuntime({
      databasePath: ":memory:",
      initialAdminAccountIds: ["admin.user"],
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      resolveAgentIdFromSessionKey: (sessionKey) => /^agent:([^:]+):/.exec(sessionKey)?.[1] ?? null,
      provisioner: { provisionOrRefresh },
      employeeAuth: {
        employeeAuthConfig: { loginUrl: "http://127.0.0.1:18080/login" },
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              authenticated: true,
              employeeId: "1001",
              accountId: "person.one",
              name: "Person One",
              department: "Platform",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        tokenFactory: () => "browser-session",
      },
      gatewayClient: {
        client: { url: "ws://127.0.0.1:18789", token: "test-auth-token" },
        createClient: (options) => {
          clientOptions = options;
          return {
            start: () => options.onHelloOk?.(hello()),
            stop,
            request: async () => ({}),
          };
        },
      },
      publicOrigin: "http://127.0.0.1:3000",
    });

    try {
      await runtime.listen({ host: "127.0.0.1", port: 0 });
      expect(clientOptions?.token).toBe("test-auth-token");
      expect(runtime.gateway.getHello()).toEqual(hello());

      await expect(
        runtime.auth.service.loginPassword({
          login: { identifier: "person.one", password: "test-password" },
        }),
      ).resolves.toMatchObject({
        status: "authenticated",
        user: { accountId: "person.one" },
        binding: { agentId: "person_one" },
      });
      expect(provisionOrRefresh).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
    expect(stop).toHaveBeenCalledOnce();
  });
});
