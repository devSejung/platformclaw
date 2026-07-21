import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const controlUiRoot = mkdtempSync(join(tmpdir(), "platformclaw-ingress-ui-"));
    mkdirSync(join(controlUiRoot, "assets"));
    writeFileSync(join(controlUiRoot, "platformclaw-login.html"), "<!doctype html>Login");
    writeFileSync(
      join(controlUiRoot, "index.html"),
      "<!doctype html><html><head><title>Control</title></head><body>App</body></html>",
    );
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
      controlUiRoot,
    });

    try {
      await runtime.listen({ host: "127.0.0.1", port: 0 });
      expect(clientOptions?.token).toBe("test-auth-token");
      expect(runtime.gateway.getHello()).toEqual(hello());
      const port = (runtime.server.address() as AddressInfo).port;
      const loginPage = await fetch(`http://127.0.0.1:${port}/platformclaw/login`);
      expect(loginPage.status).toBe(200);
      expect(await loginPage.text()).toContain("<!doctype html>Login");

      const appBeforeLogin = await fetch(
        `http://127.0.0.1:${port}/platformclaw/app/chat?view=compact`,
        { redirect: "manual" },
      );
      expect(appBeforeLogin.status).toBe(302);
      expect(appBeforeLogin.headers.get("location")).toBe(
        "/platformclaw/login?returnTo=%2Fplatformclaw%2Fapp%2Fchat%3Fview%3Dcompact",
      );
      expect(appBeforeLogin.headers.get("cache-control")).toBe("no-store");

      const login = await runtime.auth.service.loginPassword({
        login: { identifier: "person.one", password: "test-password" },
      });
      expect(login).toMatchObject({
        status: "authenticated",
        user: { accountId: "person.one" },
        binding: { agentId: "person_one" },
      });
      if (login.status !== "authenticated") {
        throw new Error(`unexpected login status: ${login.status}`);
      }
      const appAfterLogin = await fetch(`http://127.0.0.1:${port}/platformclaw/app/chat`, {
        headers: { Cookie: `platformclaw_session=${login.token}` },
      });
      expect(appAfterLogin.status).toBe(200);
      expect(await appAfterLogin.text()).toContain("<body>App</body>");
      expect(provisionOrRefresh).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
      rmSync(controlUiRoot, { recursive: true, force: true });
    }
    expect(stop).toHaveBeenCalledOnce();
  });
});
