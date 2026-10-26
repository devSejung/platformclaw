import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayClientOptions } from "@openclaw/gateway-client";
import type { HelloOk } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { BrowserGatewayProxy } from "./browser-gateway-proxy.js";
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
      scopes: [
        "operator.read",
        "operator.write",
        "operator.admin",
        "operator.approvals",
        "operator.questions",
      ],
    },
    policy: { maxPayload: 1_024, maxBufferedBytes: 2_048, tickIntervalMs: 30_000 },
  };
}

describe("createPlatformClawWebIngressRuntime", () => {
  it("assembles employee auth, the private Gateway, policy proxy, and listener", async () => {
    const closeTalk = vi.spyOn(BrowserGatewayProxy.prototype, "closeTalkForAgent");
    const controlUiRoot = mkdtempSync(join(tmpdir(), "platformclaw-ingress-ui-"));
    mkdirSync(join(controlUiRoot, "assets"));
    writeFileSync(join(controlUiRoot, "platformclaw-login.html"), "<!doctype html>Login");
    writeFileSync(
      join(controlUiRoot, "index.html"),
      '<!doctype html><html><head><title>Control</title><link rel="icon" type="image/svg+xml" href="./favicon.svg"><link rel="icon" type="image/png" href="./favicon-32.png"><link rel="apple-touch-icon" href="./apple-touch-icon.png"><link rel="manifest" href="./manifest.webmanifest"></head><body>App</body></html>',
    );
    writeFileSync(
      join(controlUiRoot, "manifest.webmanifest"),
      '{"name":"OpenClaw Control","short_name":"OpenClaw","icons":[]}',
    );
    writeFileSync(join(controlUiRoot, "favicon.svg"), "<svg>upstream favicon</svg>");
    writeFileSync(join(controlUiRoot, "favicon-32.png"), "upstream favicon png");
    writeFileSync(join(controlUiRoot, "apple-touch-icon.png"), "upstream touch icon");
    writeFileSync(
      join(controlUiRoot, "sw.js"),
      [
        'if (url.pathname.startsWith("/api/") || false) {}',
        'data = { title: "OpenClaw", body: event.data.text() };',
        'const title = data.title || "OpenClaw";',
        "const options = {",
        '  icon: "./apple-touch-icon.png",',
        '  badge: "./favicon-32.png",',
        "};",
      ].join("\n"),
    );
    writeFileSync(join(controlUiRoot, "assets", "platformclaw-pixel-ABC123.svg"), "<svg></svg>");
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
            request: async (method) =>
              method === "sessions.subscribe" ? { subscribed: true } : {},
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
      employeeSso: {
        loginUrl: "https://auth.example.test/adsso",
        handoffSecret: "s".repeat(32),
      },
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
      const executionClient = new ExecutionHandoffClient(
        deriveExecutionHandoffAddress(credentialBrokerAddress),
        "execution-service-token-with-32-bytes",
      );
      const executionTarget = await executionClient.resolveTarget("person_one");
      expect(executionTarget).toMatchObject({
        kind: "platform_server",
        agentId: "person_one",
      });
      await expect(executionClient.resolveTarget("person_one", "assigned_vm")).rejects.toThrow(
        "execution handoff request failed (409)",
      );
      const store = runtime.auth.store;
      const { user: admin } = await store.upsertPrincipal(
        { provider: "ldap", subject: "admin.user", accountId: "admin.user", employeeId: "1002" },
        4,
      );
      const endpoint = await store.createSafeConnectEndpoint({
        actorUserId: admin.id,
        label: "Test endpoint",
        host: "safeconnect.example.test",
        port: 22,
        adDomain: "example.test",
        createdAt: 5,
      });
      const hostKeyBlob = Buffer.from(
        `0000000b7373682d6564323535313900000020${"07".repeat(32)}`,
        "hex",
      );
      await store.approveSafeConnectHostKey({
        actorUserId: admin.id,
        endpointId: endpoint.id,
        algorithm: "ssh-ed25519",
        publicKey: hostKeyBlob.toString("base64"),
        fingerprint: `SHA256:${createHash("sha256").update(hostKeyBlob).digest("base64").replace(/=+$/u, "")}`,
        approvedAt: 6,
      });
      const host = await store.createVmHost({
        actorUserId: admin.id,
        endpointId: endpoint.id,
        label: "Test VM",
        targetAddress: "192.0.2.10",
        createdAt: 7,
      });
      const allocation = await store.assignVmToPersonalAgent({
        actorUserId: admin.id,
        agentId: "person_one",
        vmHostId: host.id,
        linuxAccount: "person_one",
        assignedAt: 8,
      });
      await store.recordVmConnectionResult({
        actorUserId: user.id,
        agentId: "person_one",
        expectedAllocationId: allocation.id,
        expectedTargetRevision: 0,
        checkedAt: 9,
        result: {
          status: "ready",
          remoteHomeDir: "/home/person_one",
          remoteWorkspaceDir: "/home/person_one/workspace",
        },
      });
      await expect(
        executionClient.resolveTarget("person_one", "assigned_vm"),
      ).resolves.toMatchObject({
        kind: "assigned_vm",
        allocationId: allocation.id,
        revision: 0,
      });
      await expect(store.getPersonalExecutionProfile("person_one")).resolves.toMatchObject({
        activeTarget: "platform_server",
        targetRevision: 0,
      });
      await executionClient.changeTarget({
        agentId: "person_one",
        target: "assigned_vm",
        expectedRevision: 0,
      });
      await expect(executionClient.resolveTarget("person_one", "platform_server")).resolves.toEqual(
        {
          kind: "platform_server",
          agentId: "person_one",
          targetId: "platform-server",
          revision: 1,
        },
      );
      await expect(executionClient.resolveTarget("person_one")).resolves.toMatchObject({
        kind: "assigned_vm",
        allocationId: allocation.id,
        revision: 1,
      });
      expect(clientOptions?.token).toBe("test-auth-token");
      expect(runtime.gateway.getHello()).toEqual(hello());
      const port = (runtime.server.address() as AddressInfo).port;
      const loginPage = await fetch(`http://127.0.0.1:${port}/platformclaw/login`);
      expect(loginPage.status).toBe(200);
      expect(await loginPage.text()).toContain("<!doctype html>Login");

      const adssoStart = await fetch(`http://127.0.0.1:${port}/employee/auth/adsso`, {
        redirect: "manual",
      });
      expect(adssoStart.status).toBe(302);
      expect(adssoStart.headers.get("location")).toBe("https://auth.example.test/adsso/login");

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
      await expect(runtime.auth.service.logout(login.token)).resolves.toBe(true);
      expect(closeTalk).toHaveBeenCalledWith("person_one", "logout");
      await runtime.auth.store.setManagedUserStatus({
        actorUserId: admin.id,
        targetUserId: login.user.id,
        status: "disabled",
        changedAt: Date.now(),
      });
      expect(closeTalk).toHaveBeenCalledWith("person_one", "user_disabled");
    } finally {
      await runtime.close();
      closeTalk.mockRestore();
      rmSync(controlUiRoot, { recursive: true, force: true });
    }
    expect(stop).toHaveBeenCalledOnce();
  });
});
