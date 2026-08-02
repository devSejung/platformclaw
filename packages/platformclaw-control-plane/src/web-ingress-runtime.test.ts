import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayClientOptions } from "@openclaw/gateway-client";
import type { HelloOk } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { redeemLocalCredentialGrant } from "./credential-broker-local.js";
import { ExecutionHandoffClient } from "./execution-handoff-client.js";
import { deriveExecutionHandoffAddress } from "./execution-handoff-http.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import { SshCredentialCipher } from "./ssh-credential-crypto.js";
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
    auth: {
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
    },
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
    const credentialBrokerAddress =
      process.platform === "win32"
        ? String.raw`\\.\pipe\platformclaw-runtime-${process.pid}-${randomUUID()}`
        : join(controlUiRoot, "credential.sock");
    let clientOptions: GatewayClientOptions | undefined;
    const stop = vi.fn();
    const provisionOrRefresh = vi.fn(async () => undefined);
    const reconcileAfterRestart = vi.fn(async () => ({ status: "active" }) as const);
    const runtime = createPlatformClawWebIngressRuntime({
      databasePath: ":memory:",
      initialAdminAccountIds: ["admin.user"],
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      resolveAgentIdFromSessionKey: (sessionKey) => /^agent:([^:]+):/.exec(sessionKey)?.[1] ?? null,
      provisioner: { provisionOrRefresh },
      restartRecoveryProbe: { reconcileAfterRestart },
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
        sshCredentialCipher: SshCredentialCipher.fromBase64(Buffer.alloc(32, 7).toString("base64")),
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
      adminRpc: {
        call: async () => {
          throw new Error("unexpected admin RPC");
        },
      } satisfies GatewayAdminRpc,
      publicOrigin: "http://127.0.0.1:3000",
      controlUiRoot,
      credentialBrokerAddress,
      executionServiceToken: "execution-service-token-with-32-bytes",
    });

    try {
      const { user } = await runtime.auth.store.upsertPrincipal(
        {
          provider: "ldap",
          subject: "person.one",
          accountId: "person.one",
          employeeId: "1001",
        },
        1,
      );
      await runtime.auth.store.reservePersonalAgent(user.id, 2);
      await runtime.auth.credentialVault?.replace({
        actorUserId: user.id,
        userId: user.id,
        password: "runtime broker secret",
        replacedAt: 3,
      });
      await expect(runtime.prepare()).resolves.toEqual({
        found: 1,
        activated: 1,
        failed: 0,
        disabled: 0,
      });
      expect(reconcileAfterRestart).toHaveBeenCalledOnce();
      await runtime.listen({ host: "127.0.0.1", port: 0 });
      const credentialBroker = runtime.credentialBroker;
      if (!credentialBroker) {
        throw new Error("credential broker was not assembled");
      }
      const credentialGrant = credentialBroker.issueForUser(user.id);
      const credential = await redeemLocalCredentialGrant({
        address: credentialBroker.address,
        token: credentialGrant.token,
      });
      expect(credential.password.toString("utf8")).toBe("runtime broker secret");
      expect(credential.revision).toBe(1);
      credential.password.fill(0);
      const executionHandoff = runtime.executionHandoff;
      if (!executionHandoff) {
        throw new Error("execution handoff was not assembled");
      }
      const executionTarget = await new ExecutionHandoffClient(
        deriveExecutionHandoffAddress(credentialBrokerAddress),
        "execution-service-token-with-32-bytes",
      ).resolveTarget("person_one");
      expect(executionTarget).toMatchObject({
        kind: "platform_server",
        agentId: "person_one",
      });
      expect(clientOptions?.token).toBe("test-auth-token");
      expect(runtime.gateway.getHello()).toEqual(hello());
      const port = (runtime.server.address() as AddressInfo).port;
      const loginPage = await fetch(`http://127.0.0.1:${port}/platformclaw/login`);
      expect(loginPage.status).toBe(200);
      expect(await loginPage.text()).toContain("<!doctype html>Login");

      const rootEntry = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
      expect(rootEntry.status).toBe(302);
      expect(rootEntry.headers.get("location")).toBe("/platformclaw/app/chat");
      expect(rootEntry.headers.get("cache-control")).toBe("no-store");
      expect(rootEntry.headers.get("referrer-policy")).toBe("no-referrer");

      const loginFromRoot = await fetch(`http://127.0.0.1:${port}/`);
      expect(loginFromRoot.status).toBe(200);
      expect(loginFromRoot.url).toBe(
        `http://127.0.0.1:${port}/platformclaw/login?returnTo=%2Fplatformclaw%2Fapp%2Fchat`,
      );
      expect(await loginFromRoot.text()).toContain("<!doctype html>Login");

      const rootHead = await fetch(`http://127.0.0.1:${port}/`, {
        method: "HEAD",
        redirect: "manual",
      });
      expect(rootHead.status).toBe(302);
      expect(rootHead.headers.get("location")).toBe("/platformclaw/app/chat");
      expect(await rootHead.text()).toBe("");

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
