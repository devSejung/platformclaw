import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../../src/infra/node-sqlite.js";
import type { EnterprisePrincipal } from "./contracts.js";
import { McpCredentialCipher } from "./mcp-credential-crypto.js";
import { McpCredentialVault, normalizeMcpAdditionalHeaders } from "./mcp-credential-vault.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const roots: string[] = [];
const stores: SqliteControlPlaneStore[] = [];
const serverUrl = "https://mcp.example.test/tools";

function principal(accountId: string): EnterprisePrincipal {
  return { provider: "ldap", subject: accountId, employeeId: accountId, accountId, groups: [] };
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "platformclaw-mcp-settings-"));
  roots.push(root);
  const databasePath = join(root, "control.sqlite");
  const onRevoked = vi.fn(async () => undefined);
  const open = () => {
    const store = new SqliteControlPlaneStore({
      databasePath,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      initialAdminAccountIds: ["admin"],
      onAgentCredentialsRevoked: onRevoked,
    });
    stores.push(store);
    return store;
  };
  const store = open();
  const user = (await store.upsertPrincipal(principal("alice"), 1_000)).user;
  const other = (await store.upsertPrincipal(principal("bob"), 1_000)).user;
  const admin = (await store.upsertPrincipal(principal("admin"), 1_000)).user;
  const reserved = await store.reservePersonalAgent(user.id, 1_001);
  const binding = await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: 1_002,
  });
  const cipher = McpCredentialCipher.fromBase64(Buffer.alloc(32, 9).toString("base64"));
  const vault = new McpCredentialVault(store, cipher);
  const save = (expectedRevision: number, enabled = true) =>
    vault.replaceSettings({
      actorUserId: user.id,
      userId: user.id,
      serverName: "tools",
      enabled,
      payload: { serverUrl, headers: { "X-Tenant": "private-tenant", "X-Empty": " " } },
      updatedAt: 2_000 + expectedRevision,
      expectedRevision,
    });
  return { store, user, other, admin, binding, cipher, vault, save, open, databasePath, onRevoked };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("personal MCP settings persistence", () => {
  it("resolves an active personal owner before any credential or settings exists", async () => {
    const { store, user, binding } = await harness();
    await expect(store.getActivePersonalMcpOwner(binding.agentId)).resolves.toBe(user.id);
    await expect(store.getActivePersonalMcpOwner("unknown-agent")).resolves.toBeNull();
    await expect(
      store.readEncryptedMcpSettingsForAgent(binding.agentId, "tools"),
    ).resolves.toBeNull();
    await store.transitionAgent({ bindingId: binding.id, state: "disabled", changedAt: 2_000 });
    await expect(store.getActivePersonalMcpOwner(binding.agentId)).resolves.toBeNull();
  });

  it("permits ownerless common MCP only for a registered active room agent", async () => {
    const { store, binding } = await harness();
    const reserved = await store.reserveKnoxRoomAgent({
      accountId: "knox",
      roomId: "room",
      reservedAt: 1_500,
    });
    await expect(store.getActiveCommonMcpAgent(reserved.binding.agentId)).resolves.toBe(false);
    await store.transitionAgent({
      bindingId: reserved.binding.id,
      state: "active",
      changedAt: 1_501,
    });
    await expect(store.getActiveCommonMcpAgent(reserved.binding.agentId)).resolves.toBe(true);
    await expect(store.getActivePersonalMcpOwner(reserved.binding.agentId)).resolves.toBeNull();
    await expect(store.getActiveCommonMcpAgent("unknown-agent")).resolves.toBe(false);
    await expect(store.getActiveCommonMcpAgent(binding.agentId)).resolves.toBe(false);
    await store.transitionAgent({ bindingId: binding.id, state: "disabled", changedAt: 2_000 });
    await expect(store.getActiveCommonMcpAgent(binding.agentId)).resolves.toBe(false);
    await store.transitionAgent({
      bindingId: reserved.binding.id,
      state: "disabled",
      changedAt: 2_001,
    });
    await expect(store.getActiveCommonMcpAgent(reserved.binding.agentId)).resolves.toBe(false);
  });

  it("keeps secrets encrypted across restart without changing the schema version", async () => {
    const { store, user, binding, cipher, save, open, databasePath } = await harness();
    const inspect = openNodeSqliteDatabase(databasePath);
    try {
      const version = inspect.prepare("PRAGMA user_version").get();
      await save(0, false);
      expect(inspect.prepare("PRAGMA user_version").get()).toEqual(version);
      const encrypted = await store.readEncryptedUserMcpSettings(user.id, "tools");
      expect(Buffer.from(encrypted!.ciphertext).toString("utf8")).not.toContain("private-tenant");
      expect(JSON.stringify(await store.listUserMcpSettings(user.id))).not.toContain(
        "private-tenant",
      );
      expect(JSON.stringify(await store.listAuditEvents())).not.toContain("private-tenant");
      store.close();
      stores.splice(stores.indexOf(store), 1);
      const reopened = new McpCredentialVault(open(), cipher);
      await expect(reopened.readSettingsForAgent(binding.agentId, "tools")).resolves.toMatchObject({
        enabled: false,
        revision: 1,
        payload: { serverUrl, headers: { "X-Tenant": "private-tenant" } },
      });
    } finally {
      inspect.close();
    }
  });

  it("binds ciphertext to its user, server and settings encryption purpose", async () => {
    const { store, user, other, cipher, save } = await harness();
    await save(0);
    const encrypted = (await store.readEncryptedUserMcpSettings(user.id, "tools"))!;
    expect(() => cipher.decryptSettings(other.id, "tools", encrypted)).toThrow("decryption failed");
    expect(() => cipher.decryptSettings(user.id, "other", encrypted)).toThrow("decryption failed");
    expect(() => cipher.decrypt(user.id, "tools", encrypted)).toThrow("decryption failed");
    const credential = cipher.encrypt(user.id, "tools", {
      kind: "bearer",
      serverUrl,
      token: "secret",
    });
    expect(() => cipher.decryptSettings(user.id, "tools", credential)).toThrow("decryption failed");
  });

  it("preserves static credentials and optional header values through Off and On", async () => {
    const { vault, user, save } = await harness();
    await vault.replace({
      actorUserId: user.id,
      userId: user.id,
      serverName: "tools",
      payload: { kind: "bearer", serverUrl, token: "secret" },
      updatedAt: 1_500,
    });
    await save(0);
    await save(1, false);
    await expect(vault.readSettingsForUser(user.id, "tools")).resolves.toMatchObject({
      enabled: false,
      payload: { headers: { "X-Tenant": "private-tenant" } },
    });
    await expect(vault.readPayload(user.id, "tools")).resolves.toMatchObject({ token: "secret" });
    await save(2, true);
    await expect(vault.readSettingsForUser(user.id, "tools")).resolves.toMatchObject({
      enabled: true,
      revision: 3,
    });
  });

  it("rejects concurrent stale writes and another user's settings replacement", async () => {
    const { vault, user, other, save } = await harness();
    const updates = await Promise.allSettled([save(0), save(0, false)]);
    expect(updates.map((update) => update.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    await expect(
      vault.replaceSettings({
        actorUserId: other.id,
        userId: user.id,
        serverName: "tools",
        enabled: false,
        payload: { serverUrl, headers: {} },
        updatedAt: 3_000,
        expectedRevision: 1,
      }),
    ).rejects.toThrow("owner or administrator required");
    await expect(vault.readSettingsForUser(other.id, "tools")).resolves.toBeNull();
  });

  it("commits credentials and settings atomically and keeps OAuth refresh independent", async () => {
    const { store, vault, user, databasePath } = await harness();
    const params = {
      actorUserId: user.id,
      userId: user.id,
      serverName: "tools",
      enabled: true,
      payload: { serverUrl, headers: { "X-Tenant": "private" } },
      updatedAt: 2_000,
      expectedRevision: 0,
      credential: {
        payload: { kind: "bearer" as const, serverUrl, token: "atomic-secret" },
        expectedFingerprint: null,
      },
    };
    const inspect = openNodeSqliteDatabase(databasePath);
    try {
      // Trigger a failure after the credential write to prove the entire Save rolls back.
      await store.listUserMcpSettings(user.id);
      inspect.exec(
        "CREATE TRIGGER settings_write_fault BEFORE INSERT ON user_mcp_settings BEGIN SELECT RAISE(ABORT, 'injected settings failure'); END",
      );
      await expect(vault.replaceSettings(params)).rejects.toThrow("injected settings failure");
      await expect(vault.readPayload(user.id, "tools")).resolves.toBeNull();
      await expect(store.listUserMcpSettings(user.id)).resolves.toEqual([]);
      inspect.exec("DROP TRIGGER settings_write_fault");
      await expect(vault.replaceSettings(params)).resolves.toMatchObject({
        settings: { revision: 1 },
        credential: { revision: 1 },
      });
      await vault.replace({
        actorUserId: user.id,
        userId: user.id,
        serverName: "tools",
        payload: {
          kind: "oauth",
          serverUrl,
          tokens: { access_token: "refreshed", token_type: "Bearer" },
        },
        updatedAt: 3_000,
        expectedRevision: 1,
      });
      await expect(vault.readSettingsForUser(user.id, "tools")).resolves.toMatchObject({
        revision: 1,
        payload: { headers: { "X-Tenant": "private" } },
      });
      await expect(vault.replaceSettings({ ...params, expectedRevision: 1 })).rejects.toThrow(
        "credential changed during update",
      );
      await expect(vault.readSettingsForUser(user.id, "tools")).resolves.toMatchObject({
        revision: 1,
      });
    } finally {
      inspect.close();
    }
  });

  it("clears headers and pending OAuth on account disable and never restores them on enable", async () => {
    const { store, user, admin, binding, save, onRevoked } = await harness();
    await save(0, false);
    await store.createMcpOAuthState({
      stateHash: "pending",
      userId: user.id,
      serverName: "tools",
      createdAt: 2_000,
      expiresAt: 9_000,
    });
    await store.setManagedUserStatus({
      actorUserId: admin.id,
      targetUserId: user.id,
      status: "disabled",
      changedAt: 3_000,
    });
    await expect(store.listUserMcpSettings(user.id)).resolves.toEqual([]);
    await expect(store.consumeMcpOAuthState("pending", 3_001)).resolves.toBeNull();
    await expect(store.getActivePersonalMcpOwner(binding.agentId)).resolves.toBeNull();
    expect(onRevoked).toHaveBeenCalledWith(binding.agentId);
    await expect(save(0)).rejects.toThrow("owner or administrator required");
    await store.setManagedUserStatus({
      actorUserId: admin.id,
      targetUserId: user.id,
      status: "active",
      changedAt: 4_000,
    });
    await expect(store.readEncryptedUserMcpSettings(user.id, "tools")).resolves.toBeNull();
  });

  it("normalizes blanks and rejects invalid, duplicate and oversized headers", () => {
    expect(normalizeMcpAdditionalHeaders({ "X-Blank": "  ", "X-Tenant": " tenant " })).toEqual({
      "X-Tenant": "tenant",
    });
    for (const headers of [
      { "X-A": "one", "x-a": "two" },
      { "X-Bad": "value\r\nInjected: bad" },
      { "X-Bad": "value\0" },
      { "X-Unicode": "tenant-한글" },
      { "X-Control": "value\x01" },
      { "X-Control": "\x0bvalue" },
      { "X-Control": "value\x0c" },
      { "X-Control": "value\x7f" },
      { "X-Long": "x".repeat(8 * 1024 + 1) },
      Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`X-${index}`, "v"])),
    ]) {
      expect(() => normalizeMcpAdditionalHeaders(headers)).toThrow();
    }
  });

  it("enforces the aggregate header budget independently of per-value and entry limits", () => {
    const maximum = Object.fromEntries(
      Array.from({ length: 4 }, (_, index) => [`X-${index}`, "v".repeat(8 * 1024 - 3)]),
    );
    expect(normalizeMcpAdditionalHeaders(maximum)).toEqual(maximum);
    const aggregateOverflow = { ...maximum, "X-Extra": "v" };
    expect(() => normalizeMcpAdditionalHeaders(aggregateOverflow)).toThrow("too large");
  });

  it("rejects transport-owned primary API-key names while retaining Authorization support", async () => {
    const { vault, user, binding } = await harness();
    for (const headerName of ["Host", "Content-Length", "Accept", "Mcp-Session-Id"]) {
      await expect(
        vault.replace({
          actorUserId: user.id,
          userId: user.id,
          serverName: "tools",
          payload: { kind: "api_key", serverUrl, headerName, value: "secret" },
          updatedAt: 2_000,
        }),
      ).rejects.toThrow("reserved");
    }
    await expect(vault.readPayload(user.id, "tools")).resolves.toBeNull();
    await vault.replace({
      actorUserId: user.id,
      userId: user.id,
      serverName: "tools",
      payload: { kind: "api_key", serverUrl, headerName: "Authorization", value: "custom-auth" },
      updatedAt: 2_000,
    });
    await expect(vault.resolveForAgent(binding.agentId, "tools")).resolves.toMatchObject({
      headers: { Authorization: "custom-auth" },
    });
  });

  it("retains an undecryptable credential fingerprint so an explicit replacement can recover it", async () => {
    const { store, vault, user } = await harness();
    await vault.replace({
      actorUserId: user.id,
      userId: user.id,
      serverName: "tools",
      payload: { kind: "bearer", serverUrl, token: "old-secret" },
      updatedAt: 2_000,
    });
    const original = await vault.readStatusForUser(user.id, "tools");
    const replacementVault = new McpCredentialVault(
      store,
      McpCredentialCipher.fromBase64(Buffer.alloc(32, 8).toString("base64")),
    );
    const retained = await replacementVault.readStatusForUser(user.id, "tools");
    expect(retained).toMatchObject({
      metadata: { revision: 1 },
      fingerprint: original!.fingerprint,
      payload: null,
    });
    expect(retained!.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    await replacementVault.replaceSettings({
      actorUserId: user.id,
      userId: user.id,
      serverName: "tools",
      enabled: true,
      payload: { serverUrl, headers: {} },
      updatedAt: 3_000,
      expectedRevision: 0,
      credential: {
        payload: { kind: "bearer", serverUrl, token: "replacement-secret" },
        expectedFingerprint: retained!.fingerprint,
      },
    });
    await expect(replacementVault.readPayload(user.id, "tools")).resolves.toMatchObject({
      token: "replacement-secret",
    });
  });
});
