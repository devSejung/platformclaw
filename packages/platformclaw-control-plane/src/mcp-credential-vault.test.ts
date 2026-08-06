import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlPlaneIdFactory, EnterprisePrincipal } from "./contracts.js";
import { McpCredentialCipher } from "./mcp-credential-crypto.js";
import { McpCredentialVault } from "./mcp-credential-vault.js";
import { McpOAuthService } from "./mcp-oauth-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const roots: string[] = [];

function idFactory(): ControlPlaneIdFactory {
  let id = 0;
  return {
    nextUserId: () => `user-${++id}`,
    nextBindingId: () => `binding-${++id}`,
    nextSessionId: () => `session-${++id}`,
    nextManagedScopeId: () => `scope-${++id}`,
    nextAuditEventId: () => `audit-${++id}`,
  };
}

function principal(accountId: string): EnterprisePrincipal {
  return {
    provider: "ldap",
    subject: `subject:${accountId}`,
    accountId,
    employeeId: `employee:${accountId}`,
    displayName: accountId,
    department: "Platform",
    groups: [],
  };
}

async function harness(
  accountId = "person.one",
  onAgentCredentialsRevoked?: (agentId: string) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "platformclaw-mcp-"));
  roots.push(root);
  const store = new SqliteControlPlaneStore({
    databasePath: join(root, "control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin.user"],
    idFactory: idFactory(),
    ...(onAgentCredentialsRevoked ? { onAgentCredentialsRevoked } : {}),
  });
  const created = await store.upsertPrincipal(principal(accountId), 1_000);
  const reserved = await store.reservePersonalAgent(created.user.id, 1_001);
  const binding = await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: 1_002,
  });
  const cipher = McpCredentialCipher.fromBase64(Buffer.alloc(32, 9).toString("base64"));
  return {
    store,
    vault: new McpCredentialVault(store, cipher),
    user: created.user,
    binding,
    cipher,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("McpCredentialVault", () => {
  it("encrypts user credentials and resolves them only through the active personal agent", async () => {
    const { store, vault, user, binding } = await harness();
    await vault.replace({
      actorUserId: user.id,
      userId: user.id,
      serverName: "github",
      payload: {
        kind: "bearer",
        serverUrl: "https://mcp.example.test/github",
        token: "secret-token",
      },
      updatedAt: 2_000,
    });
    await expect(
      vault.replace({
        actorUserId: user.id,
        userId: user.id,
        serverName: "github",
        payload: {
          kind: "bearer",
          serverUrl: "https://mcp.example.test/github",
          token: "stale-replacement",
        },
        updatedAt: 2_001,
        expectedRevision: 0,
      }),
    ).rejects.toThrow("changed during update");

    await expect(vault.resolveForAgent(binding.agentId, "github")).resolves.toEqual({
      headers: { Authorization: "Bearer secret-token" },
      revision: 1,
    });
    await expect(vault.resolveForAgent("other_agent", "github")).resolves.toBeNull();
    const row = await store.readEncryptedUserMcpCredential(user.id, "github");
    expect(Buffer.from(row!.ciphertext).toString("utf8")).not.toContain("secret-token");
    store.close();
  });

  it.each(["bearer", "api_key"] as const)(
    "stores and resolves personal %s credentials for an HTTP server",
    async (kind) => {
      const { store, vault, user, binding } = await harness();
      await vault.replace({
        actorUserId: user.id,
        userId: user.id,
        serverName: "intranet",
        payload:
          kind === "bearer"
            ? {
                kind,
                serverUrl: "http://mcp.example.test/intranet",
                token: "secret-token",
              }
            : {
                kind,
                serverUrl: "http://mcp.example.test/intranet",
                headerName: "X-Api-Key",
                value: "secret-key",
              },
        updatedAt: 2_000,
      });

      await expect(vault.resolveForAgent(binding.agentId, "intranet")).resolves.toEqual({
        headers:
          kind === "bearer"
            ? { Authorization: "Bearer secret-token" }
            : { "X-Api-Key": "secret-key" },
        revision: 1,
      });
      store.close();
    },
  );

  it("rejects personal OAuth credentials for an HTTP server", async () => {
    const { store, vault, user } = await harness();
    await expect(
      vault.replace({
        actorUserId: user.id,
        userId: user.id,
        serverName: "oauth",
        payload: {
          kind: "oauth",
          serverUrl: "http://mcp.example.test/oauth",
        },
        updatedAt: 2_000,
      }),
    ).rejects.toThrow("OAuth server URL must use HTTPS");
    store.close();
  });

  it("binds ciphertext to both user and server with authenticated data", async () => {
    const { store, vault, user, cipher } = await harness();
    await vault.replace({
      actorUserId: user.id,
      userId: user.id,
      serverName: "one",
      payload: {
        kind: "api_key",
        serverUrl: "https://mcp.example.test/one",
        headerName: "X-Api-Key",
        value: "secret",
      },
      updatedAt: 2_000,
    });
    const row = (await store.readEncryptedUserMcpCredential(user.id, "one"))!;
    expect(() => cipher.decrypt(user.id, "two", row)).toThrow("decryption failed");
    store.close();
  });

  it("deletes MCP credentials when an administrator disables the account", async () => {
    const { store, vault, user } = await harness();
    const admin = await store.upsertPrincipal(principal("admin.user"), 1_500);
    await vault.replace({
      actorUserId: user.id,
      userId: user.id,
      serverName: "private",
      payload: {
        kind: "bearer",
        serverUrl: "https://mcp.example.test/private",
        token: "secret",
      },
      updatedAt: 2_000,
    });

    await store.setManagedUserStatus({
      actorUserId: admin.user.id,
      targetUserId: user.id,
      status: "disabled",
      changedAt: 3_000,
    });

    await expect(store.listUserMcpCredentials(user.id)).resolves.toEqual([]);
    store.close();
  });

  it("invalidates the personal Agent after idempotent administrator bulk deletion", async () => {
    const onRevoked = vi.fn(async () => undefined);
    const { store, vault, user, binding } = await harness("person.one", onRevoked);
    const admin = await store.upsertPrincipal(principal("admin.user"), 1_500);
    await vault.replace({
      actorUserId: user.id,
      userId: user.id,
      serverName: "private",
      payload: {
        kind: "bearer",
        serverUrl: "https://mcp.example.test/private",
        token: "secret",
      },
      updatedAt: 2_000,
    });

    await expect(
      store.deleteAllUserMcpCredentials({
        actorUserId: admin.user.id,
        userId: user.id,
        deletedAt: 3_000,
      }),
    ).resolves.toBe(1);
    await expect(
      store.deleteAllUserMcpCredentials({
        actorUserId: admin.user.id,
        userId: user.id,
        deletedAt: 3_001,
      }),
    ).resolves.toBe(0);
    expect(onRevoked).toHaveBeenCalledTimes(2);
    expect(onRevoked).toHaveBeenLastCalledWith(binding.agentId);
    store.close();
  });

  it("consumes OAuth state once and rejects expired state", async () => {
    const { store, user } = await harness();
    await store.createMcpOAuthState({
      stateHash: "state-one",
      userId: user.id,
      serverName: "oauth",
      createdAt: 1_000,
      expiresAt: 2_000,
    });
    await expect(store.consumeMcpOAuthState("state-one", 1_500)).resolves.toEqual({
      userId: user.id,
      serverName: "oauth",
    });
    await expect(store.consumeMcpOAuthState("state-one", 1_600)).resolves.toBeNull();

    await store.createMcpOAuthState({
      stateHash: "superseded",
      userId: user.id,
      serverName: "oauth",
      createdAt: 1_700,
      expiresAt: 2_700,
    });
    await store.createMcpOAuthState({
      stateHash: "replacement",
      userId: user.id,
      serverName: "oauth",
      createdAt: 1_800,
      expiresAt: 2_800,
    });
    await expect(store.consumeMcpOAuthState("superseded", 1_900)).resolves.toBeNull();
    await expect(store.consumeMcpOAuthState("replacement", 1_900)).resolves.toEqual({
      userId: user.id,
      serverName: "oauth",
    });

    await store.createMcpOAuthState({
      stateHash: "expired",
      userId: user.id,
      serverName: "oauth",
      createdAt: 2_000,
      expiresAt: 3_000,
    });
    await expect(store.consumeMcpOAuthState("expired", 3_000)).resolves.toBeNull();
    store.close();
  });

  it("uses MCP SDK discovery, PKCE, one-time state, and encrypted token storage", async () => {
    const { store, vault, user } = await harness();
    let now = 10_000;
    let authorizationEndpoint = "https://auth.example.test/authorize";
    let tokenRequests = 0;
    let rejectRefresh = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "mcp.example.test") {
        return Response.json({
          resource: "https://mcp.example.test/mcp",
          authorization_servers: ["https://auth.example.test"],
        });
      }
      if (url.pathname.includes(".well-known")) {
        return Response.json({
          issuer: "https://auth.example.test",
          authorization_endpoint: authorizationEndpoint,
          token_endpoint: "https://auth.example.test/token",
          registration_endpoint: "https://auth.example.test/register",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.pathname === "/register") {
        return Response.json({
          client_id: "platformclaw-client",
          redirect_uris: ["https://claw.example.test/platformclaw/api/mcp/oauth/callback"],
        });
      }
      if (url.pathname === "/token" && init?.method === "POST") {
        tokenRequests += 1;
        if (rejectRefresh) {
          return Response.json(
            { error: "invalid_grant", error_description: "renewal grant revoked" },
            { status: 400 },
          );
        }
        return Response.json({
          access_token: `oauth-access-token-${tokenRequests}`,
          ...(tokenRequests === 1 ? { refresh_token: "oauth-refresh-token-1" } : {}),
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const oauth = new McpOAuthService({
      store,
      vault,
      redirectUrl: "https://claw.example.test/platformclaw/api/mcp/oauth/callback",
      fetchImpl: fetchImpl as typeof globalThis.fetch,
      now: () => now,
    });

    const started = await oauth.begin({
      userId: user.id,
      serverName: "oauth",
      serverUrl: "https://mcp.example.test/mcp",
    });
    expect(started.status).toBe("redirect");
    if (started.status !== "redirect") {
      throw new Error("expected OAuth redirect");
    }
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authorizationUrl.searchParams.get("state")!;
    await expect(oauth.consumeState(state)).resolves.toEqual({
      userId: user.id,
      serverName: "oauth",
    });
    await expect(oauth.consumeState(state)).resolves.toBeNull();

    now += 1_000;
    await oauth.complete({
      userId: user.id,
      serverName: "oauth",
      serverUrl: "https://mcp.example.test/mcp",
      code: "authorization-code",
    });
    await expect(vault.readPayload(user.id, "oauth")).resolves.toMatchObject({
      kind: "oauth",
      serverUrl: "https://mcp.example.test/mcp",
      tokens: { access_token: "oauth-access-token-1", refresh_token: "oauth-refresh-token-1" },
      expiresAt: now + 3_600_000,
    });

    const stale = (await vault.readForUser(user.id, "oauth"))!;
    // Refresh before the Gateway's 60-second retirement window instead of
    // returning a token that requester-scoped runtime installation rejects.
    now += 3_555_000;
    const staleOAuth =
      stale.payload as import("./mcp-credential-contracts.js").McpOAuthCredentialPayload;
    const refreshed = await Promise.all([
      oauth.resolveForAgent({
        userId: user.id,
        serverName: "oauth",
        serverUrl: "https://mcp.example.test/mcp",
        revision: stale.revision,
        payload: staleOAuth,
      }),
      oauth.resolveForAgent({
        userId: user.id,
        serverName: "oauth",
        serverUrl: "https://mcp.example.test/mcp",
        revision: stale.revision,
        payload: staleOAuth,
      }),
    ]);
    expect(tokenRequests).toBe(2);
    expect(refreshed).toEqual([
      expect.objectContaining({ headers: { Authorization: "Bearer oauth-access-token-2" } }),
      expect.objectContaining({ headers: { Authorization: "Bearer oauth-access-token-2" } }),
    ]);
    await expect(vault.readPayload(user.id, "oauth")).resolves.toMatchObject({
      tokens: { refresh_token: "oauth-refresh-token-1" },
    });

    const current = (await vault.readForUser(user.id, "oauth"))!;
    now += 3_555_000;
    rejectRefresh = true;
    await expect(
      oauth.resolveForAgent({
        userId: user.id,
        serverName: "oauth",
        serverUrl: "https://mcp.example.test/mcp",
        revision: current.revision,
        payload:
          current.payload as import("./mcp-credential-contracts.js").McpOAuthCredentialPayload,
      }),
    ).resolves.toBeNull();
    const rejectedPayload = await vault.readPayload(user.id, "oauth");
    expect(rejectedPayload).toMatchObject({ kind: "oauth" });
    expect(rejectedPayload).not.toHaveProperty("tokens");

    // The pinned SDK rejects script schemes itself but permits other non-HTTP
    // URLs such as ftp:, so Control still enforces the product boundary.
    authorizationEndpoint = "ftp://auth.example.test/authorize";
    await expect(
      oauth.begin({
        userId: user.id,
        serverName: "unsafe-oauth",
        serverUrl: "https://mcp.example.test/mcp",
      }),
    ).rejects.toThrow("authorization URL is invalid");
    store.close();
  });
});
