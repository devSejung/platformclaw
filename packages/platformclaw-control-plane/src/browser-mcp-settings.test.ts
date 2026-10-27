import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLATFORMCLAW_SESSION_COOKIE } from "./browser-auth-http.js";
import { BrowserAuthService, hashBrowserSessionToken } from "./browser-auth-service.js";
import { readBrowserJsonBody } from "./browser-http-shared.js";
import {
  EmployeeMcpService,
  handlePlatformClawEmployeeMcpRequest,
  PLATFORMCLAW_MCP_SETTINGS_PATH,
} from "./browser-mcp-http.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import { McpCredentialCipher } from "./mcp-credential-crypto.js";
import { McpCredentialVault } from "./mcp-credential-vault.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const cleanup: Array<() => Promise<void>> = [];
const roots: string[] = [];
const publicOrigin = "https://claw.example.test";

type CatalogPolicy = {
  serverName: string;
  credentialMode: "none" | "shared" | "personal";
  auth?: "bearer" | "api_key" | "oauth";
  headerName?: string;
  scope?: string;
  url: string;
  enabled: boolean;
  configuredOAuth: boolean;
  commonHeaderNames: string[];
  headerGuides: Array<{ name: string; description?: string }>;
};

async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback port unavailable");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "platformclaw-mcp-service-"));
  roots.push(root);
  const store = new SqliteControlPlaneStore({
    databasePath: join(root, "control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin"],
  });
  cleanup.push(async () => store.close());
  const createUser = async (accountId: string) => {
    const { user } = await store.upsertPrincipal(
      { provider: "ldap", subject: accountId, employeeId: accountId, accountId, groups: [] },
      1_000,
    );
    const { binding: reserved } = await store.reservePersonalAgent(user.id, 1_001);
    const binding = await store.transitionAgent({
      bindingId: reserved.id,
      state: "active",
      changedAt: 1_002,
    });
    const token = `${accountId}-session`;
    await store.createBrowserSession({
      userId: user.id,
      tokenHash: hashBrowserSessionToken(token),
      createdAt: 1_003,
    });
    return { user, binding, token };
  };
  const alice = await createUser("alice");
  const bob = await createUser("bob");
  const admin = await createUser("admin");
  const policies: CatalogPolicy[] = (["none", "shared", "personal", "oauth"] as const).map(
    (name) => ({
      serverName: name,
      credentialMode: name === "oauth" ? "personal" : name,
      auth: name === "personal" ? "bearer" : name === "oauth" ? "oauth" : undefined,
      scope: name === "oauth" ? "read" : undefined,
      url: `https://mcp.example.test/${name}`,
      enabled: true,
      configuredOAuth: false,
      commonHeaderNames: name === "shared" ? ["X-Common-Key"] : [],
      headerGuides: [{ name: "X-Tenant", description: "Optional tenant" }],
    }),
  );
  const invalidations: unknown[] = [];
  const faults = { invalidate: false };
  const clock = { now: 5_000 };
  const adminRpc: GatewayAdminRpc = {
    async call<T>(method: string, params: unknown): Promise<T> {
      if (method === "platformclaw-user-mcp.catalog") {
        return { servers: structuredClone(policies) } as T;
      }
      if (method === "platformclaw-user-mcp.invalidateAgent") {
        invalidations.push(params);
        if (faults.invalidate) {
          throw new Error("injected runtime invalidation failure");
        }
        return { disposed: 1 } as T;
      }
      throw new Error(`unexpected RPC ${method}`);
    },
  };
  const authService = new BrowserAuthService({
    store,
    authenticator: {
      authenticatePassword: async () => ({ status: "rejected", message: "not used" }),
    },
    provisioner: { provisionOrRefresh: async () => undefined },
    now: () => clock.now,
  });
  const vault = new McpCredentialVault(
    store,
    McpCredentialCipher.fromBase64(Buffer.alloc(32, 9).toString("base64")),
  );
  const oauthFetch = vi.fn<typeof fetch>(async () => {
    throw new Error("unexpected OAuth request");
  });
  const service = new EmployeeMcpService({
    store,
    vault,
    authService,
    adminRpc,
    publicOrigin,
    fetchImpl: oauthFetch,
    now: () => clock.now,
  });
  const fingerprint = async (serverName: string) => {
    const server = (await service.getSettings(alice.user.id)).servers.find(
      (entry) => entry.serverName === serverName,
    );
    if (!server) {
      throw new Error("missing server policy");
    }
    return server.policyFingerprint;
  };
  const credentialFingerprint = async (serverName: string) => {
    const server = (await service.getSettings(alice.user.id)).servers.find(
      (entry) => entry.serverName === serverName,
    );
    if (!server) {
      throw new Error("missing credential policy");
    }
    return server.credentialFingerprint;
  };
  const save = async (
    serverName: string,
    expectedRevision: number,
    changes: {
      enabled?: boolean;
      headers?: unknown;
      credential?: unknown;
      expectedPolicyFingerprint?: string;
      expectedCredentialFingerprint?: string | null;
    } = {},
  ) => {
    const expectedPolicyFingerprint =
      changes.expectedPolicyFingerprint ??
      (changes.headers !== undefined || changes.credential !== undefined
        ? await fingerprint(serverName)
        : undefined);
    const expectedCredentialFingerprint =
      changes.expectedCredentialFingerprint !== undefined
        ? changes.expectedCredentialFingerprint
        : changes.credential !== undefined
          ? await credentialFingerprint(serverName)
          : undefined;
    return await service.updateSettings({
      userId: alice.user.id,
      agentId: alice.binding.agentId,
      serverName,
      expectedRevision,
      ...changes,
      expectedPolicyFingerprint,
      expectedCredentialFingerprint,
    });
  };
  const updatePolicy = (name: string, changes: Partial<CatalogPolicy>) => {
    const policy = policies.find((entry) => entry.serverName === name);
    if (!policy) {
      throw new Error("missing policy");
    }
    Object.assign(policy, changes);
    service.invalidateCatalog();
  };
  const startHttp = async () =>
    listen(
      createServer((req, res) => {
        void handlePlatformClawEmployeeMcpRequest(req, res, {
          service,
          readJsonBody: readBrowserJsonBody,
          isMutationOriginAllowed: (request) => request.headers.origin === publicOrigin,
        })
          .then((handled) => {
            if (!handled) {
              res.statusCode = 404;
              res.end();
            }
          })
          .catch(() => {
            res.statusCode = 500;
            res.end("unexpected server error");
          });
      }),
    );
  return {
    store,
    vault,
    alice,
    bob,
    admin,
    service,
    save,
    updatePolicy,
    invalidations,
    faults,
    clock,
    fingerprint,
    credentialFingerprint,
    oauthFetch,
    startHttp,
  };
}

afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("MCP settings with real user sessions and encrypted persistence", () => {
  it("projects all authentication modes and returns header names without values", async () => {
    const { service, save, alice, bob } = await harness();
    const initial = await service.getSettings(alice.user.id);
    expect(
      initial.servers.map(({ serverName, credentialMode, configured }) => ({
        serverName,
        credentialMode,
        configured,
      })),
    ).toEqual([
      { serverName: "none", credentialMode: "none", configured: true },
      { serverName: "shared", credentialMode: "shared", configured: true },
      { serverName: "personal", credentialMode: "personal", configured: false },
      { serverName: "oauth", credentialMode: "personal", configured: false },
    ]);
    const settings = await save("shared", 0, {
      headers: [
        { name: "X-Tenant", value: "tenant-private" },
        { name: "X-Custom", value: "custom-private" },
      ],
    });
    expect(settings.servers.find(({ serverName }) => serverName === "shared")).toMatchObject({
      origin: "organization",
      headers: [
        { name: "X-Custom", configured: true },
        { name: "X-Tenant", configured: true },
      ],
      settingsRevision: 1,
    });
    expect(JSON.stringify(settings)).not.toContain("tenant-private");
    expect(JSON.stringify(settings)).not.toContain("custom-private");
    expect(
      (await service.getSettings(bob.user.id)).servers.every(({ headers }) => headers.length === 0),
    ).toBe(true);
  });

  it("omits guided blanks, preserves masked values by name, and explicitly deletes cleared headers", async () => {
    const { save, vault, alice } = await harness();
    await save("none", 0, {
      headers: [
        { name: "X-Tenant", value: "" },
        { name: "X-Custom", value: "secret" },
        { name: "", value: "" },
      ],
    });
    await expect(vault.readSettingsForUser(alice.user.id, "none")).resolves.toMatchObject({
      payload: { headers: { "X-Custom": "secret" } },
    });
    await save("none", 1, {
      headers: [{ name: "x-custom" }, { name: "X-Tenant", value: "tenant" }],
    });
    await expect(vault.readSettingsForUser(alice.user.id, "none")).resolves.toMatchObject({
      payload: { headers: { "x-custom": "secret", "X-Tenant": "tenant" } },
    });
    await save("none", 2, {
      headers: [
        { name: "x-custom", value: "" },
        { name: "X-Tenant", value: " " },
      ],
    });
    expect((await vault.readSettingsForUser(alice.user.id, "none"))?.payload.headers).toEqual({});
  });

  it("stores valid object-property header names without silently dropping their values", async () => {
    const { save, vault, service, alice } = await harness();
    await save("none", 0, { headers: [{ name: "__proto__", value: "literal-header" }] });
    const settings = await vault.readSettingsForUser(alice.user.id, "none");
    expect(Object.entries(settings!.payload.headers)).toEqual([["__proto__", "literal-header"]]);
    expect(
      Object.entries((await service.resolveForAgent(alice.binding.agentId, "none"))!.headers),
    ).toEqual([["__proto__", "literal-header"]]);
  });

  it("rejects invalid bearer and API-key values before either half of Save commits", async () => {
    const { save, vault, alice, updatePolicy } = await harness();
    for (const kind of ["bearer", "api_key"] as const) {
      updatePolicy("personal", {
        auth: kind,
        ...(kind === "api_key" ? { headerName: "X-Approved-Key" } : {}),
      });
      for (const secret of ["한글", "value\x01", "\x0bvalue", "value\x7f"]) {
        await expect(
          save("personal", 0, {
            headers: [{ name: "X-Tenant", value: "not-committed" }],
            credential: { kind, secret },
          }),
        ).rejects.toThrow();
      }
    }
    await expect(vault.readPayload(alice.user.id, "personal")).resolves.toBeNull();
    await expect(vault.readSettingsForUser(alice.user.id, "personal")).resolves.toBeNull();
  });

  it("saves credentials and headers together, retains them through Off/On, and invalidates only the owner", async () => {
    const { service, save, vault, alice, invalidations } = await harness();
    const response = await save("personal", 0, {
      enabled: false,
      headers: [{ name: "X-Tenant", value: "tenant" }],
      credential: { kind: "bearer", secret: "personal-secret" },
    });
    expect(JSON.stringify(response)).not.toContain("personal-secret");
    await expect(service.resolveForAgent(alice.binding.agentId, "personal")).resolves.toBeNull();
    await expect(vault.readPayload(alice.user.id, "personal")).resolves.toMatchObject({
      token: "personal-secret",
    });
    await save("personal", 1, { enabled: true });
    await expect(service.resolveForAgent(alice.binding.agentId, "personal")).resolves.toMatchObject(
      { headers: { Authorization: "Bearer personal-secret", "X-Tenant": "tenant" } },
    );
    await save("personal", 2, { enabled: false });
    await save("personal", 3, { enabled: true });
    await expect(service.resolveForAgent(alice.binding.agentId, "personal")).resolves.toMatchObject(
      { headers: { Authorization: "Bearer personal-secret", "X-Tenant": "tenant" } },
    );
    expect(invalidations).toEqual(
      Array.from({ length: 4 }, () => ({ agentId: alice.binding.agentId })),
    );
  });

  it.each([
    [
      "none",
      [
        { name: "X-Duplicate", value: "a" },
        { name: "x-duplicate", value: "b" },
      ],
    ],
    ["none", [{ name: "Mcp-Session-Id", value: "overwrite" }]],
    ["none", [{ name: "Host", value: "other.test" }]],
    ["shared", [{ name: "x-common-key", value: "overwrite" }]],
    ["personal", [{ name: "authorization", value: "overwrite" }]],
    ["none", [{ name: "X-Unicode", value: "한글" }]],
    ["none", [{ name: "X-Injected", value: "one\r\nX-Evil: two" }]],
  ] as const)(
    "rejects invalid or policy-conflicting %s headers before committing %#",
    async (name, headers) => {
      const { save, vault, alice, invalidations } = await harness();
      await expect(save(name, 0, { headers })).rejects.toThrow();
      await expect(vault.readSettingsForUser(alice.user.id, name)).resolves.toBeNull();
      expect(invalidations).toEqual([]);
    },
  );

  it("keeps Off after a server URL change and never forwards old destination headers", async () => {
    const { save, service, alice, updatePolicy } = await harness();
    await save("none", 0, {
      enabled: false,
      headers: [{ name: "X-Tenant", value: "old-destination-secret" }],
    });
    updatePolicy("none", { url: "https://new-mcp.example.test/tools" });
    const entry = (await service.getSettings(alice.user.id)).servers.find(
      ({ serverName }) => serverName === "none",
    );
    expect(entry).toMatchObject({
      userEnabled: false,
      headers: [],
      headerError: expect.any(String),
    });
    await expect(service.resolveForAgent(alice.binding.agentId, "none")).resolves.toBeNull();
    await save("none", 1, { enabled: true });
    await expect(service.resolveForAgent(alice.binding.agentId, "none")).resolves.toBeNull();
    await save("none", 2, { headers: [] });
    await expect(service.resolveForAgent(alice.binding.agentId, "none")).resolves.toMatchObject({
      headers: {},
    });
  });

  it("preserves encrypted destination-bound headers through permission-only toggles after URL replacement", async () => {
    const { save, service, vault, alice, updatePolicy } = await harness();
    await save("shared", 0, { headers: [{ name: "X-Tenant", value: "keep-old-secret" }] });
    updatePolicy("shared", { url: "https://replacement.example.test/shared" });
    for (const [expectedRevision, enabled] of [
      [1, false],
      [2, true],
    ] as const) {
      await save("shared", expectedRevision, { enabled });
      await expect(vault.readSettingsForUser(alice.user.id, "shared")).resolves.toMatchObject({
        enabled,
        payload: {
          serverUrl: "https://mcp.example.test/shared",
          headers: { "X-Tenant": "keep-old-secret" },
        },
      });
      await expect(service.resolveForAgent(alice.binding.agentId, "shared")).resolves.toBeNull();
    }
    const row = (await service.getSettings(alice.user.id)).servers.find(
      ({ serverName }) => serverName === "shared",
    );
    expect(row).toMatchObject({ userEnabled: true, headers: [], headerError: expect.any(String) });
    await save("shared", 3, { headers: [{ name: "X-Tenant", value: "replacement-secret" }] });
    await expect(service.resolveForAgent(alice.binding.agentId, "shared")).resolves.toMatchObject({
      headers: { "X-Tenant": "replacement-secret" },
    });
  });

  it("allows deleting previously saved headers that a new common or personal authentication policy reserves", async () => {
    const { save, vault, alice, updatePolicy, service } = await harness();
    for (const name of ["shared", "personal"] as const) {
      await save(name, 0, { headers: [{ name: "X-Tenant", value: "old-user-value" }] });
      updatePolicy(name, {
        headerGuides: [],
        ...(name === "shared"
          ? { commonHeaderNames: ["X-Tenant"] }
          : { auth: "api_key", headerName: "X-Tenant" }),
      });
      const row = (await service.getSettings(alice.user.id)).servers.find(
        ({ serverName }) => serverName === name,
      );
      expect(row?.headerError).toEqual(expect.any(String));
      await expect(save(name, 1, { headers: [{ name: "X-Tenant" }] })).rejects.toThrow("reserved");
      await save(name, 1, {
        headers: [
          { name: "x-tenant", value: "" },
          { name: "X-Custom", value: "retained" },
        ],
      });
      expect((await vault.readSettingsForUser(alice.user.id, name))?.payload.headers).toEqual({
        "X-Custom": "retained",
      });
      const updated = (await service.getSettings(alice.user.id)).servers.find(
        ({ serverName }) => serverName === name,
      );
      expect(updated?.headerError).toBeUndefined();
    }
  });

  it("requires an active personal owner or an explicitly registered active room", async () => {
    const { store, service, alice, admin } = await harness();
    const room = await store.reserveKnoxRoomAgent({
      accountId: "knox",
      roomId: "room",
      reservedAt: 2_000,
    });
    await store.transitionAgent({ bindingId: room.binding.id, state: "active", changedAt: 2_001 });
    await expect(service.resolveForAgent(alice.binding.agentId, "none")).resolves.toMatchObject({
      headers: {},
    });
    await expect(service.resolveForAgent(room.binding.agentId, "shared")).resolves.toMatchObject({
      headers: {},
    });
    await expect(service.resolveForAgent(room.binding.agentId, "personal")).resolves.toBeNull();
    await expect(service.resolveForAgent("unregistered", "shared")).resolves.toBeNull();
    await store.setManagedUserStatus({
      actorUserId: admin.user.id,
      targetUserId: alice.user.id,
      status: "disabled",
      changedAt: 3_000,
    });
    await expect(service.resolveForAgent(alice.binding.agentId, "shared")).resolves.toBeNull();
  });

  it("cannot override administrator Off and stops before OAuth refresh when the user switches Off", async () => {
    const { vault, service, save, alice, updatePolicy, oauthFetch } = await harness();
    await save("none", 0, { enabled: true });
    updatePolicy("none", { enabled: false });
    await save("none", 1, { headers: [{ name: "X-Tenant", value: "editable-while-global-off" }] });
    expect(
      (await service.getSettings(alice.user.id)).servers.find(
        ({ serverName }) => serverName === "none",
      ),
    ).toMatchObject({ userEnabled: true, globalEnabled: false });
    await save("none", 2, { enabled: false });
    await expect(save("none", 3, { enabled: true })).rejects.toThrow("administrator disabled");
    await expect(service.resolveForAgent(alice.binding.agentId, "none")).resolves.toBeNull();
    await vault.replace({
      actorUserId: alice.user.id,
      userId: alice.user.id,
      serverName: "oauth",
      payload: {
        kind: "oauth",
        serverUrl: "https://mcp.example.test/oauth",
        scope: "read",
        tokens: { access_token: "expired", refresh_token: "renewal", token_type: "Bearer" },
        expiresAt: 1_000,
      },
      updatedAt: 2_000,
    });
    await save("oauth", 0, { enabled: false });
    await expect(service.resolveForAgent(alice.binding.agentId, "oauth")).resolves.toBeNull();
    expect(oauthFetch).not.toHaveBeenCalled();
    await expect(vault.readPayload(alice.user.id, "oauth")).resolves.toMatchObject({
      tokens: { refresh_token: "renewal" },
    });
  });

  it("rejects stale concurrent saves without mixing their credentials and headers", async () => {
    const { save, vault, alice } = await harness();
    const updates = await Promise.allSettled(
      ["one", "two"].map((value) =>
        save("personal", 0, {
          headers: [{ name: "X-Tenant", value }],
          credential: { kind: "bearer", secret: value },
        }),
      ),
    );
    expect(updates.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(updates.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const settings = await vault.readSettingsForUser(alice.user.id, "personal");
    const credential = await vault.readPayload(alice.user.id, "personal");
    expect(credential?.kind).toBe("bearer");
    expect(credential && "token" in credential ? credential.token : undefined).toBe(
      settings?.payload.headers["X-Tenant"],
    );
  });

  it("retains additional headers while SDK OAuth authorization and concurrent token refresh update credentials", async () => {
    const { service, save, vault, alice, oauthFetch, clock } = await harness();
    let tokenRequests = 0;
    oauthFetch.mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "mcp.example.test") {
        return Response.json({
          resource: "https://mcp.example.test/oauth",
          authorization_servers: ["https://auth.example.test"],
        });
      }
      if (url.pathname.includes(".well-known")) {
        return Response.json({
          issuer: "https://auth.example.test",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          registration_endpoint: "https://auth.example.test/register",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/register") {
        return Response.json({
          client_id: "settings-client",
          redirect_uris: [`${publicOrigin}/platformclaw/api/mcp/oauth/callback`],
        });
      }
      if (url.pathname === "/token" && init?.method === "POST") {
        tokenRequests += 1;
        return Response.json({
          access_token: `oauth-token-${tokenRequests}`,
          ...(tokenRequests === 1 ? { refresh_token: "oauth-renewal" } : {}),
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const started = await service.beginOAuth(alice.user.id, alice.binding.agentId, "oauth");
    if (started.status !== "redirect") {
      throw new Error("OAuth redirect required");
    }
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("OAuth state missing");
    }
    await service.completeOAuth({
      userId: alice.user.id,
      agentId: alice.binding.agentId,
      state,
      code: "authorized-code",
    });
    await save("oauth", 0, { headers: [{ name: "X-Tenant", value: "oauth-tenant" }] });
    clock.now += 3_555_000;
    const resolved = await Promise.all([
      service.resolveForAgent(alice.binding.agentId, "oauth"),
      service.resolveForAgent(alice.binding.agentId, "oauth"),
    ]);
    expect(tokenRequests).toBe(2);
    for (const connection of resolved) {
      expect(connection?.headers).toEqual({
        "X-Tenant": "oauth-tenant",
        Authorization: "Bearer oauth-token-2",
      });
    }
    await expect(vault.readPayload(alice.user.id, "oauth")).resolves.toMatchObject({
      tokens: { access_token: "oauth-token-2", refresh_token: "oauth-renewal" },
    });
    await expect(vault.readSettingsForUser(alice.user.id, "oauth")).resolves.toMatchObject({
      revision: 1,
      payload: { headers: { "X-Tenant": "oauth-tenant" } },
    });
  });

  it("reports retained invalid credentials as stored until the authenticated owner deletes them", async () => {
    const { service, save, vault, alice, updatePolicy } = await harness();
    await save("personal", 0, { credential: { kind: "bearer", secret: "retained-secret" } });
    updatePolicy("personal", { url: "https://replacement.example.test/personal" });
    const stale = (await service.getSettings(alice.user.id)).servers.find(
      ({ serverName }) => serverName === "personal",
    );
    expect(stale).toMatchObject({ configured: false, credentialStored: true });
    expect(JSON.stringify(stale)).not.toContain("retained-secret");
    await service.remove(alice.user.id, alice.binding.agentId, "personal");
    await expect(vault.readPayload(alice.user.id, "personal")).resolves.toBeNull();
    const cleared = (await service.getSettings(alice.user.id)).servers.find(
      ({ serverName }) => serverName === "personal",
    );
    expect(cleared).toMatchObject({ configured: false, credentialStored: false });
  });

  it("uses actual session and origin boundaries and ignores a forged target user", async () => {
    const { startHttp, alice, bob, store, admin, vault, fingerprint } = await harness();
    const endpoint = `${await startHttp()}${PLATFORMCLAW_MCP_SETTINGS_PATH}`;
    const put = (token: string | undefined, origin: string, body: unknown) =>
      fetch(endpoint, {
        method: "PUT",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...(token ? { Cookie: `${PLATFORMCLAW_SESSION_COOKIE}=${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const body = {
      serverName: "none",
      expectedRevision: 0,
      expectedPolicyFingerprint: await fingerprint("none"),
      userId: bob.user.id,
      headers: [{ name: "X-Tenant", value: "alice-secret" }],
    };
    expect((await put(undefined, publicOrigin, body)).status).toBe(401);
    expect((await put(alice.token, "https://other.example.test", body)).status).toBe(403);
    expect((await put(alice.token, publicOrigin, { ...body, enabled: "true" })).status).toBe(400);
    expect(
      (await put(alice.token, publicOrigin, { ...body, expectedPolicyFingerprint: undefined }))
        .status,
    ).toBe(409);
    expect((await put(alice.token, publicOrigin, body)).status).toBe(200);
    await expect(vault.readSettingsForUser(bob.user.id, "none")).resolves.toBeNull();
    await expect(vault.readSettingsForUser(alice.user.id, "none")).resolves.toMatchObject({
      payload: { headers: { "X-Tenant": "alice-secret" } },
    });
    expect((await put(alice.token, publicOrigin, body)).status).toBe(409);
    expect(
      (
        await put(alice.token, publicOrigin, {
          ...body,
          headers: [{ name: "X-Large", value: "x".repeat(90 * 1024) }],
        })
      ).status,
    ).toBe(400);
    const get = await fetch(endpoint, {
      headers: { Cookie: `${PLATFORMCLAW_SESSION_COOKIE}=${alice.token}` },
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(await get.text()).not.toContain("alice-secret");
    await store.setManagedUserStatus({
      actorUserId: admin.user.id,
      targetUserId: alice.user.id,
      status: "disabled",
      changedAt: 6_000,
    });
    expect((await put(alice.token, publicOrigin, { ...body, expectedRevision: 1 })).status).toBe(
      401,
    );
  });

  it("rejects stale plaintext drafts after an administrator changes destination until values are deliberately re-entered", async () => {
    const { fingerprint, save, service, vault, alice, updatePolicy, invalidations } =
      await harness();
    const originalPolicy = await fingerprint("personal");
    await save("personal", 0, { credential: { kind: "bearer", secret: "original-auth" } });
    updatePolicy("personal", { url: "https://replacement.example.test/personal" });
    const staleDraft = {
      headers: [{ name: "X-Tenant", value: "old-destination-draft" }],
      credential: { kind: "bearer", secret: "old-destination-token" },
      expectedPolicyFingerprint: originalPolicy,
    };
    await expect(save("personal", 1, staleDraft)).rejects.toThrow("Reload MCP settings");
    expect(invalidations).toHaveLength(1);
    await expect(vault.readSettingsForUser(alice.user.id, "personal")).resolves.toMatchObject({
      revision: 1,
      payload: { serverUrl: "https://mcp.example.test/personal", headers: {} },
    });
    await expect(vault.readPayload(alice.user.id, "personal")).resolves.toMatchObject({
      serverUrl: "https://mcp.example.test/personal",
      token: "original-auth",
    });
    await expect(service.resolveForAgent(alice.binding.agentId, "personal")).resolves.toBeNull();
    const currentPolicy = await fingerprint("personal");
    expect(currentPolicy).not.toBe(originalPolicy);
    await save("personal", 1, {
      expectedPolicyFingerprint: currentPolicy,
      headers: [{ name: "X-Tenant", value: "new-destination-value" }],
      credential: { kind: "bearer", secret: "new-destination-token" },
    });
    await expect(service.resolveForAgent(alice.binding.agentId, "personal")).resolves.toMatchObject(
      {
        headers: {
          "X-Tenant": "new-destination-value",
          Authorization: "Bearer new-destination-token",
        },
      },
    );
  });

  it("reports a committed Save when invalidation fails and permits a revision-aware retry", async () => {
    const { startHttp, alice, vault, service, faults, invalidations, fingerprint } =
      await harness();
    const endpoint = `${await startHttp()}${PLATFORMCLAW_MCP_SETTINGS_PATH}`;
    const put = (body: unknown) =>
      fetch(endpoint, {
        method: "PUT",
        headers: {
          Origin: publicOrigin,
          "Content-Type": "application/json",
          Cookie: `${PLATFORMCLAW_SESSION_COOKIE}=${alice.token}`,
        },
        body: JSON.stringify(body),
      });
    const body = {
      serverName: "personal",
      expectedRevision: 0,
      expectedPolicyFingerprint: await fingerprint("personal"),
      expectedCredentialFingerprint: null,
      enabled: false,
      headers: [{ name: "X-Tenant", value: "persisted-header-secret" }],
      credential: { kind: "bearer", secret: "persisted-auth-secret" },
    };
    faults.invalidate = true;
    const failedRefresh = await put(body);
    expect(failedRefresh.status).toBe(503);
    const response = (await failedRefresh.json()) as {
      saved: boolean;
      error: string;
      servers: Array<{ serverName: string; settingsRevision: number; userEnabled: boolean }>;
    };
    expect(response.saved).toBe(true);
    expect(response.error).toContain("were saved");
    const saved = response.servers.find(({ serverName }) => serverName === "personal");
    expect(saved).toMatchObject({ settingsRevision: 1, userEnabled: false });
    expect(JSON.stringify(response)).not.toContain("persisted-header-secret");
    expect(JSON.stringify(response)).not.toContain("persisted-auth-secret");
    await expect(vault.readSettingsForUser(alice.user.id, "personal")).resolves.toMatchObject({
      revision: 1,
      enabled: false,
      payload: { headers: { "X-Tenant": "persisted-header-secret" } },
    });
    await expect(vault.readPayload(alice.user.id, "personal")).resolves.toMatchObject({
      token: "persisted-auth-secret",
    });
    faults.invalidate = false;
    const stale = await put({
      ...body,
      headers: [{ name: "X-Tenant", value: "stale-header" }],
      credential: { kind: "bearer", secret: "stale-auth" },
    });
    expect(stale.status).toBe(409);
    await expect(vault.readPayload(alice.user.id, "personal")).resolves.toMatchObject({
      token: "persisted-auth-secret",
    });
    const retry = await put({
      serverName: "personal",
      expectedPolicyFingerprint: await fingerprint("personal"),
      expectedRevision: saved!.settingsRevision,
      enabled: true,
      headers: [{ name: "X-Tenant" }],
    });
    expect(retry.status).toBe(200);
    await expect(vault.readSettingsForUser(alice.user.id, "personal")).resolves.toMatchObject({
      revision: 2,
      enabled: true,
    });
    await expect(service.resolveForAgent(alice.binding.agentId, "personal")).resolves.toMatchObject(
      {
        headers: {
          "X-Tenant": "persisted-header-secret",
          Authorization: "Bearer persisted-auth-secret",
        },
      },
    );
    expect(invalidations).toHaveLength(2);
  });

  it.each([false, true])(
    "rejects credential drafts after another client deletes or recreates the credential (recreate=%s)",
    async (recreate) => {
      const { save, service, store, alice, invalidations } = await harness();
      await save("personal", 0, {
        headers: [{ name: "X-Tenant", value: "unchanged" }],
        credential: { kind: "bearer", secret: "original-secret" },
      });
      const snapshot = (await service.getSettings(alice.user.id)).servers.find(
        ({ serverName }) => serverName === "personal",
      )!;
      await service.remove(alice.user.id, alice.binding.agentId, "personal");
      if (recreate) {
        await service.replace({
          userId: alice.user.id,
          agentId: alice.binding.agentId,
          serverName: "personal",
          kind: "bearer",
          secret: "original-secret",
        });
      }
      const current = (await service.getSettings(alice.user.id)).servers.find(
        ({ serverName }) => serverName === "personal",
      )!;
      expect(current.settingsRevision).toBe(snapshot.settingsRevision);
      expect(current.credentialFingerprint).not.toBe(snapshot.credentialFingerprint);
      if (recreate) {
        expect(current.revision).toBe(snapshot.revision);
      }
      const settingsBefore = await store.readEncryptedUserMcpSettings(alice.user.id, "personal");
      const credentialBefore = await store.readEncryptedUserMcpCredential(
        alice.user.id,
        "personal",
      );
      const invalidationsBefore = invalidations.length;
      await expect(
        save("personal", snapshot.settingsRevision, {
          expectedCredentialFingerprint: snapshot.credentialFingerprint,
          headers: [{ name: "X-Tenant", value: "must-not-commit" }],
          credential: { kind: "bearer", secret: "stale-editor-secret" },
        }),
      ).rejects.toThrow("credential changed during update");
      expect(await store.readEncryptedUserMcpSettings(alice.user.id, "personal")).toEqual(
        settingsBefore,
      );
      expect(await store.readEncryptedUserMcpCredential(alice.user.id, "personal")).toEqual(
        credentialBefore,
      );
      expect(invalidations).toHaveLength(invalidationsBefore);
    },
  );

  it.each([
    ["sse", "bearer"],
    ["sse", "api_key"],
    ["streamable-http", "bearer"],
    ["streamable-http", "api_key"],
  ] as const)(
    "sends resolved personal authentication and optional headers over actual %s transport with %s",
    async (kind, auth) => {
      const { save, service, alice, updatePolicy } = await harness();
      const received: Array<{ method: string | undefined; headers: IncomingHttpHeaders }> = [];
      const errors: unknown[] = [];
      const sdk = new McpServer(
        { name: "settings-proof", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      sdk.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "ping", inputSchema: { type: "object" } }],
      }));
      sdk.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      let sse: SSEServerTransport | undefined;
      const http = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
      });
      if (kind === "streamable-http") {
        await sdk.connect(http);
      }
      const server = createServer((req, res) => {
        received.push({ method: req.method, headers: { ...req.headers } });
        const handle = async () => {
          if (kind === "streamable-http") {
            return await http.handleRequest(req, res);
          }
          if (req.method === "GET") {
            sse = new SSEServerTransport("/messages", res);
            await sdk.connect(sse);
          } else if (sse) {
            await sse.handlePostMessage(req, res);
          } else {
            res.statusCode = 400;
            res.end();
          }
        };
        void handle().catch((error: unknown) => {
          errors.push(error);
          res.statusCode = 500;
          res.end();
        });
      });
      const url = `${await listen(server)}/${kind === "sse" ? "sse" : "mcp"}`;
      cleanup.push(async () => {
        await sdk.close();
      });
      updatePolicy("personal", {
        url,
        auth,
        ...(auth === "api_key" ? { headerName: "X-Approved-Key" } : {}),
      });
      await save("personal", 0, {
        headers: [
          { name: "X-Tenant", value: "wire-tenant" },
          { name: "X-Custom", value: "wire-custom" },
          { name: "X-Empty", value: "" },
        ],
        credential: { kind: auth, secret: "wire-token" },
      });
      const resolved = await service.resolveForAgent(alice.binding.agentId, "personal", url);
      expect(resolved).not.toBeNull();
      const headers = resolved!.headers;
      const client = new Client({ name: "settings-client", version: "1.0.0" });
      cleanup.push(async () => client.close());
      const transport =
        kind === "sse"
          ? new SSEClientTransport(new URL(url), { requestInit: { headers } })
          : new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
      await client.connect(transport, { timeout: 5_000 });
      expect((await client.listTools({}, { timeout: 5_000 })).tools).toEqual([
        expect.objectContaining({ name: "ping" }),
      ]);
      expect(
        await client.callTool({ name: "ping", arguments: {} }, undefined, { timeout: 5_000 }),
      ).toMatchObject({ content: [{ type: "text", text: "pong" }] });
      expect(received.length).toBeGreaterThanOrEqual(4);
      expect(received.some(({ method }) => method === "POST")).toBe(true);
      for (const request of received) {
        expect(request.headers).toMatchObject({
          ...(auth === "bearer"
            ? { authorization: "Bearer wire-token" }
            : { "x-approved-key": "wire-token" }),
          "x-tenant": "wire-tenant",
          "x-custom": "wire-custom",
        });
        expect(request.headers["x-empty"]).toBeUndefined();
      }
      expect(errors).toEqual([]);
    },
  );
});
