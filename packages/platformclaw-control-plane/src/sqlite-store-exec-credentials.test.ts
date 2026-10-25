import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneConflictError } from "./contracts.js";
import { createExecCredentialTestContext } from "./exec-credential.test-support.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const contexts: Awaited<ReturnType<typeof createExecCredentialTestContext>>[] = [];
async function setup(addDefinition = true) {
  const context = await createExecCredentialTestContext();
  contexts.push(context);
  if (addDefinition) {
    await context.service.addDefinition(context.admin.user.id, "API_TOKEN");
  }
  return context;
}
afterEach(() => {
  for (const context of contexts.splice(0)) {
    context.close();
  }
});

describe("SqliteControlPlaneExecCredentialStore", () => {
  it("reads authorized metadata without decrypting and resolves values only for the active personal owner", async () => {
    const c = await setup();
    const decrypt = vi.spyOn(c.cipher, "decrypt");
    const expected = await c.preconditions(c.member.user, "API_TOKEN");
    expect(
      await c.service.metadataForAgent(c.member.agentId, `agent:${c.member.agentId}:main`),
    ).toEqual({ definitions: [{ envName: "API_TOKEN", configured: false }] });
    await c.service.replace(c.member.user.id, "API_TOKEN", "synthetic-value", expected);
    expect(
      await c.service.metadataForAgent(c.member.agentId, `agent:${c.member.agentId}:main`),
    ).toEqual({
      definitions: [{ envName: "API_TOKEN", configured: true, revision: 1, updatedAt: 100 }],
    });
    expect(decrypt).not.toHaveBeenCalled();
    const dormant = (
      await c.store.upsertPrincipal(
        {
          provider: "ldap",
          subject: "subject:dormant",
          accountId: "dormant",
          employeeId: "dormant",
        },
        2,
      )
    ).user;
    const reserved = await c.store.reservePersonalAgent(dormant.id, 3);
    expect(
      await c.service.metadataForAgent(
        reserved.binding.agentId,
        `agent:${reserved.binding.agentId}:main`,
      ),
    ).toEqual({ status: "unsupported", code: "scope" });
    for (const key of [
      "catalog-one",
      "agent:other:main",
      `agent:${c.member.agentId}:space-session:one`,
      `agent:${c.member.agentId}:subagent:one`,
      `agent:${c.member.agentId}:acp:one`,
      `agent:${c.member.agentId}:knox:group:one`,
    ]) {
      expect(await c.service.metadataForAgent(c.member.agentId, key)).toEqual({
        status: "unsupported",
        code: "scope",
      });
    }
    expect(await c.service.resolveForAgent("room-agent")).toEqual({});
    expect(await c.service.resolveForAgent(c.member.agentId)).toEqual({
      API_TOKEN: "synthetic-value",
    });
    await c.store.setManagedUserStatus({
      actorUserId: c.admin.user.id,
      targetUserId: c.member.user.id,
      status: "disabled",
      changedAt: 101,
    });
    expect(
      await c.service.metadataForAgent(c.member.agentId, `agent:${c.member.agentId}:main`),
    ).toEqual({ status: "unsupported", code: "scope" });
    expect(await c.service.resolveForAgent(c.member.agentId)).toEqual({});
  });

  it("rejects stale create, overwrite, delete, and deleted-value resurrection through the real service", async () => {
    const c = await setup();
    const initial = await c.preconditions(c.member.user, "API_TOKEN");
    const first = await c.service.replace(c.member.user.id, "API_TOKEN", "first-value", initial);
    expect(first).toMatchObject({ revision: 1, definitionToken: initial.expectedDefinitionToken });
    await expect(
      c.service.replace(c.member.user.id, "API_TOKEN", "stale-create", initial),
    ).rejects.toMatchObject({ code: "credential-changed" });
    const stale = await c.preconditions(c.member.user, "API_TOKEN");
    await c.service.replace(c.member.user.id, "API_TOKEN", "newer-value", stale);
    await expect(
      c.service.replace(c.member.user.id, "API_TOKEN", "stale-overwrite", stale),
    ).rejects.toMatchObject({ code: "credential-changed" });
    await expect(c.service.remove(c.member.user.id, "API_TOKEN", stale)).rejects.toMatchObject({
      code: "credential-changed",
    });
    expect(await c.service.resolveForAgent(c.member.agentId)).toEqual({ API_TOKEN: "newer-value" });
    const beforeDelete = await c.preconditions(c.member.user, "API_TOKEN");
    expect(await c.service.remove(c.member.user.id, "API_TOKEN", beforeDelete)).toMatchObject({
      deleted: true,
      credentialToken: null,
    });
    await expect(
      c.service.replace(c.member.user.id, "API_TOKEN", "resurrected", beforeDelete),
    ).rejects.toBeInstanceOf(ControlPlaneConflictError);
    expect(await c.service.resolveForAgent(c.member.agentId)).toEqual({});
  });

  it("distinguishes value and definition generations when revision and timestamps are reused", async () => {
    const c = await setup();
    const initial = await c.preconditions(c.member.user, "API_TOKEN");
    const first = await c.service.replace(c.member.user.id, "API_TOKEN", "first-value", initial);
    const old = await c.preconditions(c.member.user, "API_TOKEN");
    await c.service.remove(c.member.user.id, "API_TOKEN", old);
    const recreated = await c.service.replace(
      c.member.user.id,
      "API_TOKEN",
      "recreated-value",
      await c.preconditions(c.member.user, "API_TOKEN"),
    );
    expect(recreated.revision).toBe(first.revision);
    expect(recreated.definitionToken).toBe(first.definitionToken);
    expect(recreated.credentialToken).not.toBe(first.credentialToken);
    await expect(c.service.remove(c.member.user.id, "API_TOKEN", old)).rejects.toMatchObject({
      code: "credential-changed",
    });
    await c.service.removeDefinition(c.admin.user.id, "API_TOKEN", first.definitionToken);
    expect(await c.service.resolveForAgent(c.member.agentId)).toEqual({});
    await c.service.addDefinition(c.admin.user.id, "API_TOKEN");
    const newDefinition = await c.preconditions(c.member.user, "API_TOKEN");
    expect(newDefinition.expectedCredentialToken).toBeNull();
    expect(newDefinition.expectedDefinitionToken).not.toBe(initial.expectedDefinitionToken);
    await expect(
      c.service.replace(c.member.user.id, "API_TOKEN", "stale-definition", initial),
    ).rejects.toMatchObject({ code: "credential-changed" });
    await expect(
      c.service.removeDefinition(c.admin.user.id, "API_TOKEN", initial.expectedDefinitionToken),
    ).rejects.toMatchObject({ code: "credential-changed" });
  });

  it("backfills existing rows, persists tokens through reopen, and covers older writers without a schema bump", async () => {
    const c = await setup(false);
    const databasePath = join(c.directory, "control.sqlite");
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      const envelope = c.cipher.encrypt(c.member.user.id, "API_TOKEN", "legacy-value");
      db.prepare(
        "INSERT INTO exec_credential_definitions (env_name, created_by_user_id, created_at) VALUES (?, ?, ?)",
      ).run("API_TOKEN", c.admin.user.id, 100);
      db.prepare(`INSERT INTO encrypted_user_exec_credentials
        (user_id, env_name, ciphertext, nonce, auth_tag, key_id, format_version, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1, 100, 100)`).run(
        c.member.user.id,
        "API_TOKEN",
        envelope.ciphertext,
        envelope.nonce,
        envelope.authTag,
        envelope.keyId,
      );
      const before = await c.preconditions(c.member.user, "API_TOKEN");
      expect(before.expectedCredentialToken).toEqual(expect.any(String));
      const reopened = new SqliteControlPlaneStore({
        databasePath,
        buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
        initialAdminAccountIds: ["admin.user"],
      });
      try {
        const definition = (await reopened.listExecCredentialDefinitions(c.member.user.id))[0]!;
        expect(definition.definitionToken).toBe(before.expectedDefinitionToken);
        expect(definition.credentialToken).toBe(before.expectedCredentialToken);
      } finally {
        reopened.close();
      }
      // Simulate the older build's canonical writer; persisted triggers rotate identity too.
      db.prepare(
        "UPDATE encrypted_user_exec_credentials SET revision = revision + 1 WHERE user_id = ? AND env_name = ?",
      ).run(c.member.user.id, "API_TOKEN");
      const after = await c.preconditions(c.member.user, "API_TOKEN");
      expect(after.expectedDefinitionToken).toBe(before.expectedDefinitionToken);
      expect(after.expectedCredentialToken).not.toBe(before.expectedCredentialToken);
      await expect(c.service.remove(c.member.user.id, "API_TOKEN", before)).rejects.toMatchObject({
        code: "credential-changed",
      });
      db.prepare("DELETE FROM exec_credential_definitions WHERE env_name = ?").run("API_TOKEN");
      db.prepare(
        "INSERT INTO exec_credential_definitions (env_name, created_by_user_id, created_at) VALUES (?, ?, ?)",
      ).run("API_TOKEN", c.admin.user.id, 100);
      const readded = await c.preconditions(c.member.user, "API_TOKEN");
      expect(readded.expectedDefinitionToken).not.toBe(before.expectedDefinitionToken);
      expect(readded.expectedCredentialToken).toBeNull();
      expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
    } finally {
      db.close();
    }
  });

  it("rechecks the current owner before a delete or definition mutation", async () => {
    const c = await setup();
    const expected = await c.preconditions(c.member.user, "API_TOKEN");
    await c.service.replace(c.member.user.id, "API_TOKEN", "saved-value", expected);
    const saved = await c.preconditions(c.member.user, "API_TOKEN");
    await c.store.setManagedUserStatus({
      actorUserId: c.admin.user.id,
      targetUserId: c.member.user.id,
      status: "disabled",
      changedAt: 101,
    });
    await expect(c.service.remove(c.member.user.id, "API_TOKEN", saved)).rejects.toThrow(
      "active credential owner",
    );
    await expect(
      c.service.removeDefinition(c.member.user.id, "API_TOKEN", saved.expectedDefinitionToken),
    ).rejects.toThrow("administrator");
  });
});
