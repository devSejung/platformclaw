import { createHmac } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createEmployeeBrowserAuthRuntime } from "./browser-auth-runtime.js";
import type { ManagedScope, PlatformUser } from "./contracts.js";
import { EmployeeSsoService } from "./employee-sso.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const sourceAt = Date.parse("2026-10-20T01:00:00Z");
const syncedAt = sourceAt + 100_000;
const directories: string[] = [];
const stores = new Set<SqliteControlPlaneStore>();

type DirectoryOrg = {
  version: number;
  source: string;
  updatedAt: string;
  team: string | null;
  group: { id: string; name: string } | null;
  part: { id: string; name: string } | null;
};

function org(overrides: Partial<DirectoryOrg> = {}): DirectoryOrg {
  return {
    version: 1,
    source: "aicm",
    updatedAt: new Date(sourceAt).toISOString(),
    team: "Engineering",
    group: { id: "platform", name: "Platform" },
    part: { id: "runtime", name: "Runtime" },
    ...overrides,
  };
}

function openStore(databasePath: string): SqliteControlPlaneStore {
  const store = new SqliteControlPlaneStore({
    databasePath,
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin"],
  });
  stores.add(store);
  return store;
}

function closeStore(store: SqliteControlPlaneStore): void {
  store.close();
  stores.delete(store);
}

async function user(store: SqliteControlPlaneStore, accountId: string): Promise<PlatformUser> {
  return (
    await store.upsertPrincipal(
      {
        provider: "ldap",
        subject: accountId,
        accountId,
        employeeId: accountId,
      },
      syncedAt,
    )
  ).user;
}

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "platformclaw-directory-")));
  directories.push(directory);
  const databasePath = join(directory, "control.sqlite");
  const store = openStore(databasePath);
  const admin = await user(store, "admin");
  const member = await user(store, "member");
  return { store, databasePath, admin, member };
}

function sync(store: SqliteControlPlaneStore, userId: string, value: unknown = org()) {
  return store.syncDirectoryOrganization({ userId, org: value, isTestAccount: false, syncedAt });
}

async function scope(store: SqliteControlPlaneStore, externalKey: string): Promise<ManagedScope> {
  const result = (await store.listManagedScopes()).find(
    (entry) => entry.externalKey === externalKey,
  );
  expect(result, externalKey).toBeDefined();
  return result!;
}

async function state(store: SqliteControlPlaneStore, userId: string) {
  return {
    scopes: await store.listManagedScopes(),
    memberships: await store.listUserManagedScopeMemberships(userId),
  };
}

afterEach(() => {
  for (const store of stores) {
    store.close();
  }
  stores.clear();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("directory organization synchronization", () => {
  it("creates one external hierarchy and membership across repeat logins, connections, and restart", async () => {
    const { store, member, databasePath } = await fixture();
    const second = openStore(databasePath);
    const results = await Promise.all([sync(store, member.id), sync(second, member.id)]);
    expect(results).toEqual([
      expect.objectContaining({ status: "synced" }),
      expect.objectContaining({ status: "synced" }),
    ]);
    const part = await scope(store, "aicm-part:runtime");
    const group = await scope(store, "group:platform");
    const team = await scope(store, "team:Engineering");
    expect(part).toMatchObject({ kind: "part", parentScopeId: group.id, managedBy: "ldap-login" });
    expect(group).toMatchObject({ kind: "group", parentScopeId: team.id, managedBy: "ldap-login" });
    expect(team).toMatchObject({ kind: "team", managedBy: "ldap-login" });
    expect(await store.listManagedScopes()).toHaveLength(3);
    expect(await store.listUserManagedScopeMemberships(member.id)).toMatchObject([
      { scopeId: part.id, userId: member.id, role: "member", managedBy: "ldap-login" },
    ]);
    closeStore(second);
    closeStore(store);
    const reopened = openStore(databasePath);
    expect(await sync(reopened, member.id)).toMatchObject({ status: "synced", scopeId: part.id });
    expect(await reopened.listManagedScopes()).toHaveLength(3);
    expect(await reopened.listUserManagedScopeMemberships(member.id)).toHaveLength(1);
  });

  it("renames by stable id and moves shared ancestors for every member of the part", async () => {
    const { store, member } = await fixture();
    const colleague = await user(store, "colleague");
    await sync(store, member.id);
    await sync(store, colleague.id);
    const part = await scope(store, "aicm-part:runtime");
    const oldGroup = await scope(store, "group:platform");
    const oldTeam = await scope(store, "team:Engineering");
    await sync(
      store,
      member.id,
      org({
        updatedAt: new Date(sourceAt + 1_000).toISOString(),
        part: { id: "runtime", name: "Execution" },
        group: { id: "services", name: "Services" },
        team: "Technology",
      }),
    );
    const newGroup = await scope(store, "group:services");
    const newTeam = await scope(store, "team:Technology");
    expect(await scope(store, "aicm-part:runtime")).toMatchObject({
      id: part.id,
      name: "Execution",
      parentScopeId: newGroup.id,
    });
    for (const target of [member, colleague]) {
      const ids = (await store.listEffectiveManagedScopeAccess(target.id)).map(
        (entry) => entry.scope.id,
      );
      expect(ids).toEqual(expect.arrayContaining([part.id, newGroup.id, newTeam.id]));
      expect(ids).not.toContain(oldGroup.id);
      expect(ids).not.toContain(oldTeam.id);
    }
    expect(await store.getManagedScope(oldGroup.id)).not.toBeNull();
    expect(await store.getManagedScope(oldTeam.id)).not.toBeNull();
  });

  it("updates a stable group's name and team without changing its id", async () => {
    const { store, member } = await fixture();
    await sync(store, member.id);
    const group = await scope(store, "group:platform");
    await sync(
      store,
      member.id,
      org({
        updatedAt: new Date(sourceAt + 1_000).toISOString(),
        group: { id: "platform", name: "Core Systems" },
        team: "Technology",
      }),
    );
    const team = await scope(store, "team:Technology");
    expect(await scope(store, "group:platform")).toMatchObject({
      id: group.id,
      name: "Core Systems",
      parentScopeId: team.id,
    });
  });

  it("keeps known parents when group or team is unknown and permits new parts under a known group", async () => {
    const { store, member } = await fixture();
    await sync(store, member.id);
    const original = await scope(store, "aicm-part:runtime");
    await expect(
      sync(
        store,
        member.id,
        org({
          group: null,
          team: null,
          updatedAt: new Date(sourceAt + 1_000).toISOString(),
          part: { id: "runtime", name: "Runtime Revised" },
        }),
      ),
    ).resolves.toMatchObject({ status: "synced" });
    expect(await scope(store, "aicm-part:runtime")).toMatchObject({
      id: original.id,
      parentScopeId: original.parentScopeId,
    });
    await expect(
      sync(
        store,
        member.id,
        org({
          team: null,
          updatedAt: new Date(sourceAt + 2_000).toISOString(),
          part: { id: "tooling", name: "Tooling" },
        }),
      ),
    ).resolves.toMatchObject({ status: "synced" });
    expect(await scope(store, "aicm-part:tooling")).toMatchObject({
      parentScopeId: original.parentScopeId,
    });
    expect(await store.listUserManagedScopeMemberships(member.id)).toMatchObject([
      { scopeId: (await scope(store, "aicm-part:tooling")).id },
    ]);
  });

  it.each([{ group: null }, { team: null }])(
    "defers incomplete new hierarchy without partial organization writes: %j",
    async (missing) => {
      const { store, member } = await fixture();
      await expect(sync(store, member.id, org(missing))).resolves.toMatchObject({
        status: "skipped",
      });
      expect(await state(store, member.id)).toEqual({ scopes: [], memberships: [] });
      await expect(sync(store, member.id)).resolves.toMatchObject({ status: "synced" });
    },
  );

  it.each([
    undefined,
    null,
    "malformed",
    [],
    {},
    org({ source: "mapping" }),
    org({ version: 2 }),
    org({ part: null }),
    org({ updatedAt: "invalid" }),
    { ...org(), part: { id: null, name: "Runtime" } },
    { ...org(), part: { id: "", name: "Runtime" } },
    { ...org(), group: { name: "Platform" } },
  ])(
    "ignores absent, untrusted, and malformed organization data without changing access: %j",
    async (value) => {
      const { store, member } = await fixture();
      await sync(store, member.id);
      const before = await state(store, member.id);
      // Pass undefined directly; the helper's default deliberately represents a valid org.
      await expect(
        store.syncDirectoryOrganization({
          userId: member.id,
          org: value,
          isTestAccount: false,
          syncedAt,
        }),
      ).resolves.toMatchObject({ status: "skipped" });
      expect(await state(store, member.id)).toEqual(before);
    },
  );

  it("does not create or move organization state for test-account authentication", async () => {
    const { store, member } = await fixture();
    await expect(
      store.syncDirectoryOrganization({
        userId: member.id,
        org: org(),
        isTestAccount: true,
        syncedAt,
      }),
    ).resolves.toMatchObject({ status: "skipped" });
    expect(await store.listManagedScopes()).toEqual([]);
    await sync(store, member.id);
    const before = await state(store, member.id);
    await store.syncDirectoryOrganization({
      userId: member.id,
      org: org({ part: { id: "tooling", name: "Tooling" } }),
      isTestAccount: true,
      syncedAt,
    });
    expect(await state(store, member.id)).toEqual(before);
  });

  it("rejects stale user moves and stale shared-organization edits from another user", async () => {
    const { store, member } = await fixture();
    const colleague = await user(store, "colleague");
    await sync(store, member.id);
    await sync(
      store,
      colleague.id,
      org({
        updatedAt: new Date(sourceAt + 3_000).toISOString(),
        part: { id: "runtime", name: "Runtime New" },
        group: { id: "platform", name: "Platform New" },
        team: "Technology",
      }),
    );
    const freshScopes = await store.listManagedScopes();
    await sync(store, member.id, org({ updatedAt: new Date(sourceAt + 1_000).toISOString() }));
    expect(await store.listManagedScopes()).toEqual(freshScopes);
    await sync(
      store,
      member.id,
      org({
        updatedAt: new Date(sourceAt + 4_000).toISOString(),
        part: { id: "tooling", name: "Tooling" },
      }),
    );
    const moved = await state(store, member.id);
    await sync(store, member.id, org());
    expect(await state(store, member.id)).toEqual(moved);
  });

  it.each(["before", "after"])(
    "preserves manual leader authority granted %s automatic membership",
    async (when) => {
      const { store, admin, member } = await fixture();
      const seed = await user(store, "seed");
      await sync(store, seed.id);
      const part = await scope(store, "aicm-part:runtime");
      const grant = () =>
        store.setManagedScopeMembership({
          actorUserId: admin.id,
          userId: member.id,
          scopeId: part.id,
          role: "leader",
          reason: "explicit delegated responsibility",
          changedAt: syncedAt,
        });
      if (when === "before") {
        await grant();
      }
      await sync(store, member.id);
      if (when === "after") {
        await grant();
      }
      expect(await store.listUserManagedScopeMemberships(member.id)).toMatchObject([
        { scopeId: part.id, role: "leader", managedBy: "ldap-login", manualRole: "leader" },
      ]);
      await sync(
        store,
        member.id,
        org({
          updatedAt: new Date(sourceAt + 1_000).toISOString(),
          part: { id: "tooling", name: "Tooling" },
        }),
      );
      const memberships = await store.listUserManagedScopeMemberships(member.id);
      expect(memberships).toHaveLength(2);
      expect(memberships.find((entry) => entry.scopeId === part.id)).toMatchObject({
        role: "leader",
      });
      expect(memberships.find((entry) => entry.scopeId === part.id)?.managedBy).toBeUndefined();
      expect(memberships.find((entry) => entry.scopeId !== part.id)).toMatchObject({
        role: "member",
        managedBy: "ldap-login",
      });
    },
  );

  it("allows equal external names without merging manual organizations or distinct external ids", async () => {
    const { store, admin, member } = await fixture();
    const manualTeam = await store.createManagedScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Engineering",
      createdAt: syncedAt,
    });
    const manualGroup = await store.createManagedScope({
      actorUserId: admin.id,
      kind: "group",
      name: "Platform",
      parentScopeId: manualTeam.id,
      createdAt: syncedAt,
    });
    const manualPart = await store.createManagedScope({
      actorUserId: admin.id,
      kind: "part",
      name: "Runtime",
      parentScopeId: manualGroup.id,
      createdAt: syncedAt,
    });
    await store.setManagedScopeMembership({
      actorUserId: admin.id,
      userId: member.id,
      scopeId: manualPart.id,
      role: "member",
      reason: "manual project access",
      changedAt: syncedAt,
    });
    await sync(store, member.id);
    const first = await scope(store, "aicm-part:runtime");
    await sync(
      store,
      member.id,
      org({
        updatedAt: new Date(sourceAt + 1_000).toISOString(),
        part: { id: "another-runtime", name: "Runtime" },
      }),
    );
    const second = await scope(store, "aicm-part:another-runtime");
    expect(second.id).not.toBe(first.id);
    expect(
      (await store.listManagedScopes()).filter((entry) => entry.name === "Runtime"),
    ).toHaveLength(3);
    const memberships = await store.listUserManagedScopeMemberships(member.id);
    expect(memberships.map((entry) => entry.scopeId)).toEqual(
      expect.arrayContaining([manualPart.id, second.id]),
    );
    expect(memberships.map((entry) => entry.scopeId)).not.toContain(first.id);
    expect((await store.getManagedScope(manualPart.id))?.managedBy).toBeUndefined();
  });

  it("rolls back membership removal and source checkpoints on failure, then retries the same data", async () => {
    const { store, databasePath, member } = await fixture();
    await sync(store, member.id);
    const before = await state(store, member.id);
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`CREATE TRIGGER fail_directory_membership BEFORE INSERT ON managed_scope_memberships
        BEGIN SELECT RAISE(ABORT, 'injected membership insert failure'); END`);
      const moved = org({
        updatedAt: new Date(sourceAt + 1_000).toISOString(),
        part: { id: "tooling", name: "Tooling" },
      });
      await expect(sync(store, member.id, moved)).rejects.toThrow(
        "injected membership insert failure",
      );
      expect(await state(store, member.id)).toEqual(before);
      database.exec("DROP TRIGGER fail_directory_membership");
      await expect(sync(store, member.id, moved)).resolves.toMatchObject({ status: "synced" });
      expect(await store.listUserManagedScopeMemberships(member.id)).toMatchObject([
        { scopeId: (await scope(store, "aicm-part:tooling")).id },
      ]);
    } finally {
      database.close();
    }
  });

  it("rejects administrative rename and archive of automatic organizations at the store boundary", async () => {
    const { store, admin, member } = await fixture();
    await sync(store, member.id);
    const part = await scope(store, "aicm-part:runtime");
    await expect(
      store.renameManagedScope({
        actorUserId: admin.id,
        scopeId: part.id,
        name: "Manual Rename",
        reason: "operator edit",
        changedAt: syncedAt,
      }),
    ).rejects.toThrow();
    await expect(
      store.archiveManagedScope({
        actorUserId: admin.id,
        scopeId: part.id,
        reason: "operator archive",
        archivedAt: syncedAt,
      }),
    ).rejects.toThrow();
    expect(await store.getManagedScope(part.id)).toMatchObject({
      name: "Runtime",
      status: "active",
    });
  });

  it("runs real LDAP HTTP and signed SSO into the same persistent organization owner", async () => {
    const { store, databasePath, member } = await fixture();
    const server = createServer((request, response) => {
      request.resume();
      response.setHeader("Content-Type", "application/json");
      if (request.method !== "POST" || request.url !== "/login") {
        response.statusCode = 404;
        response.end(JSON.stringify({ authenticated: false }));
        return;
      }
      response.end(JSON.stringify({ authenticated: true, employeeId: "member", org: org() }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("loopback LDAP server address unavailable");
    }
    const runtime = createEmployeeBrowserAuthRuntime({
      databasePath,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      provisioner: { async provisionOrRefresh() {} },
      initialAdminAccountIds: ["admin"],
      employeeAuthConfig: { loginUrl: `http://127.0.0.1:${address.port}/login` },
      now: () => syncedAt,
    });
    const secret = "directory-boundary-test-secret-32-bytes";
    const service = new EmployeeSsoService({
      authService: runtime.service,
      config: { loginUrl: "https://auth.example.test/adsso", handoffSecret: secret },
      now: () => syncedAt,
    });
    const signed = (value: unknown, signingSecret = secret, expired = false) => {
      const issued = Math.floor(syncedAt / 1000) - (expired ? 61 : 0);
      const bytes = Buffer.from(
        JSON.stringify({
          contractVersion: 1,
          kind: "sso",
          issuer: "platformclaw-auth",
          audience: "platformclaw",
          authMethod: "saml",
          employeeId: "member",
          agentId: "member",
          sessionKey: "agent:member:main",
          iat: issued,
          exp: issued + 60,
          org: value,
        }),
      );
      return `${bytes.toString("base64url")}.${createHmac("sha256", signingSecret).update(bytes).digest("base64url")}`;
    };
    try {
      const login = await runtime.service.loginPassword({
        login: { identifier: "member", password: "test-password" },
      });
      expect(login).toMatchObject({ status: "authenticated", user: { id: member.id } });
      if (login.status !== "authenticated") {
        throw new Error("LDAP boundary login failed");
      }
      expect(await store.listUserManagedScopeMemberships(member.id)).toHaveLength(1);
      const next = org({
        updatedAt: new Date(sourceAt + 1_000).toISOString(),
        part: { id: "tooling", name: "Tooling" },
      });
      const token = signed(next);
      await expect(service.complete(token, { value: login.token })).resolves.toMatchObject({
        status: "authenticated",
        user: { id: member.id },
        session: { id: login.session.id },
      });
      expect(await store.listUserManagedScopeMemberships(member.id)).toMatchObject([
        { scopeId: (await scope(store, "aicm-part:tooling")).id },
      ]);
      const before = await state(store, member.id);
      for (const rejected of [
        token,
        signed(org(), "wrong signing key"),
        signed(org(), secret, true),
      ]) {
        await expect(service.complete(rejected)).resolves.toEqual({ status: "invalid-handoff" });
        expect(await state(store, member.id)).toEqual(before);
      }
    } finally {
      runtime.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
