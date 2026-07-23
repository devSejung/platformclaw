import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ControlPlaneAuditReader,
  ControlPlaneIdFactory,
  ControlPlaneManagementStore,
  ControlPlaneStore,
  EnterprisePrincipal,
} from "./contracts.js";
import { InMemoryControlPlaneStore } from "./memory-store.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";
import type { ControlPlaneSshCredentialEnvelopeStore } from "./ssh-credential-contracts.js";
import { SshCredentialCipher } from "./ssh-credential-crypto.js";
import { SshCredentialVault } from "./ssh-credential-vault.js";

type CredentialTestStore = ControlPlaneStore &
  Pick<ControlPlaneManagementStore, "setManagedUserStatus"> &
  ControlPlaneAuditReader &
  ControlPlaneSshCredentialEnvelopeStore & { close?: () => void };

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function idFactory(): ControlPlaneIdFactory {
  let counter = 0;
  const next = (kind: string) => `${kind}-${++counter}`;
  return {
    nextUserId: () => next("user"),
    nextBindingId: () => next("binding"),
    nextSessionId: () => next("session"),
    nextManagedScopeId: () => next("scope"),
    nextAuditEventId: () => next("audit"),
    nextExecutionResourceId: (kind) => next(kind),
  };
}

function principal(accountId: string): EnterprisePrincipal {
  return {
    provider: "ldap",
    subject: `subject-${accountId}`,
    accountId,
    employeeId: accountId,
  };
}

function createMemoryStore(): CredentialTestStore {
  return new InMemoryControlPlaneStore({
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["person.one"],
    idFactory: idFactory(),
  });
}

function createSqliteStore(): CredentialTestStore {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-credential-vault-"));
  temporaryDirectories.push(directory);
  return new SqliteControlPlaneStore({
    databasePath: join(directory, "control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["person.one"],
    idFactory: idFactory(),
  });
}

const masterKey = Buffer.alloc(32, 7).toString("base64");

describe.each([
  ["memory", createMemoryStore],
  ["sqlite", createSqliteStore],
] as const)("%s SSH credential vault", (_name, createStore) => {
  it("encrypts, replaces, invalidates, and deletes only the owning user's credential", async () => {
    const store = createStore();
    const owner = (await store.upsertPrincipal(principal("person.one"), 1_000)).user;
    const other = (await store.upsertPrincipal(principal("person.two"), 1_001)).user;
    const vault = new SshCredentialVault(store, SshCredentialCipher.fromBase64(masterKey));

    const first = await vault.replace({
      actorUserId: owner.id,
      userId: owner.id,
      password: "first secret",
      replacedAt: 2_000,
    });
    expect(first).toMatchObject({ revision: 1, status: "current" });
    expect(first).not.toHaveProperty("ciphertext");
    await expect(vault.resolveForBroker(owner.id)).resolves.toEqual({
      password: "first secret",
      revision: 1,
    });
    await expect(
      vault.replace({
        actorUserId: other.id,
        userId: owner.id,
        password: "forbidden",
        replacedAt: 2_001,
      }),
    ).rejects.toThrow("only their own SSH credential");

    const second = await vault.replace({
      actorUserId: owner.id,
      userId: owner.id,
      password: "second secret",
      replacedAt: 3_000,
    });
    expect(second).toMatchObject({ id: first.id, revision: 2, status: "current" });
    await expect(
      vault.markUpdateRequired({ userId: owner.id, revision: 1, failedAt: 3_500 }),
    ).resolves.toMatchObject({ revision: 2, status: "current" });
    await expect(vault.resolveForBroker(owner.id)).resolves.toMatchObject({ revision: 2 });
    await vault.markUpdateRequired({ userId: owner.id, revision: 2, failedAt: 4_000 });
    await expect(vault.resolveForBroker(owner.id)).rejects.toThrow("requires an update");

    const third = await vault.replace({
      actorUserId: owner.id,
      userId: owner.id,
      password: "third secret",
      replacedAt: 5_000,
    });
    expect(third).toMatchObject({ revision: 3, status: "current" });
    expect(third).not.toHaveProperty("lastAuthFailureAt");
    expect(JSON.stringify(await store.listAuditEvents())).not.toContain("secret");

    await expect(
      vault.delete({ actorUserId: owner.id, userId: owner.id, deletedAt: 6_000 }),
    ).resolves.toBe(true);
    await expect(vault.resolveForBroker(owner.id)).rejects.toThrow("not configured");
    store.close?.();
  });

  it("blocks broker resolution immediately after the owner is disabled", async () => {
    const store = createStore();
    const admin = (await store.upsertPrincipal(principal("person.one"), 1_000)).user;
    const owner = (await store.upsertPrincipal(principal("person.two"), 1_001)).user;
    const vault = new SshCredentialVault(store, SshCredentialCipher.fromBase64(masterKey));
    await vault.replace({
      actorUserId: owner.id,
      userId: owner.id,
      password: "offboarding secret",
      replacedAt: 2_000,
    });

    await store.setManagedUserStatus({
      actorUserId: admin.id,
      targetUserId: owner.id,
      status: "disabled",
      changedAt: 3_000,
    });

    await expect(vault.resolveForBroker(owner.id)).rejects.toThrow(
      "active user required for SSH credential resolution",
    );
    store.close?.();
  });
});

describe("SshCredentialCipher", () => {
  it("binds ciphertext to the user and configured master key", () => {
    const cipher = SshCredentialCipher.fromBase64(masterKey);
    const envelope = cipher.encrypt("user-1", "password with spaces ");

    expect(cipher.decrypt("user-1", envelope)).toBe("password with spaces ");
    expect(() => cipher.decrypt("user-2", envelope)).toThrow("decryption failed");
    expect(() =>
      SshCredentialCipher.fromBase64(Buffer.alloc(32, 8).toString("base64")).decrypt(
        "user-1",
        envelope,
      ),
    ).toThrow("unavailable master key");
  });

  it("rejects malformed or incorrectly sized master keys and empty passwords", () => {
    expect(() => SshCredentialCipher.fromBase64("not base64")).toThrow("canonical Base64");
    expect(() => SshCredentialCipher.fromBase64(Buffer.alloc(31).toString("base64"))).toThrow(
      "decode to 32 bytes",
    );
    expect(() => SshCredentialCipher.fromBase64(masterKey).encrypt("user-1", "")).toThrow(
      "must contain 1 to",
    );
  });
});

describe("SQLite SSH credential persistence", () => {
  it("survives restart with the matching key and never persists plaintext", async () => {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-credential-restart-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "control.sqlite");
    const cipher = SshCredentialCipher.fromBase64(masterKey);
    const createStore = () =>
      new SqliteControlPlaneStore({
        databasePath,
        buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
        initialAdminAccountIds: ["person.one"],
        idFactory: idFactory(),
      });
    const firstStore = createStore();
    const owner = (await firstStore.upsertPrincipal(principal("person.one"), 1_000)).user;
    const password = "PLATFORMCLAW_DB_PLAINTEXT_SENTINEL_7f1d";
    await new SshCredentialVault(firstStore, cipher).replace({
      actorUserId: owner.id,
      userId: owner.id,
      password,
      replacedAt: 2_000,
    });
    firstStore.close();

    for (const file of readdirSync(directory)) {
      expect(readFileSync(join(directory, file)).includes(Buffer.from(password))).toBe(false);
    }

    const secondStore = createStore();
    await expect(
      new SshCredentialVault(secondStore, cipher).resolveForBroker(owner.id),
    ).resolves.toEqual({ password, revision: 1 });
    await expect(
      new SshCredentialVault(
        secondStore,
        SshCredentialCipher.fromBase64(Buffer.alloc(32, 8).toString("base64")),
      ).resolveForBroker(owner.id),
    ).rejects.toThrow("unavailable master key");
    secondStore.close();
  });
});
