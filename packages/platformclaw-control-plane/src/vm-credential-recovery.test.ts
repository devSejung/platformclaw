import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupExecutionStoreDirectories,
  createActivePersonalAgent,
  createSqliteStore,
  prepareVm,
} from "./execution-store.test-support.js";

afterEach(cleanupExecutionStoreDirectories);

const INITIAL_ENVELOPE = {
  ciphertext: new Uint8Array([1]),
  nonce: new Uint8Array(12),
  authTag: new Uint8Array(16),
  keyId: `sha256:${"A".repeat(43)}`,
  formatVersion: 1 as const,
};
const REPLACEMENT_ENVELOPE = { ...INITIAL_ENVELOPE, ciphertext: new Uint8Array([2]) };

async function recoveryFixture() {
  const store = createSqliteStore();
  const { admin, host } = await prepareVm(store);
  const employee = await createActivePersonalAgent(store, "recovery.user");
  const identity = { actorUserId: employee.user.id, agentId: employee.binding.agentId };
  await store.commitPersonalVmSelection({
    ...identity,
    vmHostId: host.id,
    linuxAccount: "recovery.user",
    remoteHomeDir: "/home/recovery.user",
    remoteWorkspaceDir: "/home/recovery.user/workspace",
    credentialEnvelope: INITIAL_ENVELOPE,
    committedAt: 8_000,
  });
  const target = await store.changePersonalExecutionTarget({
    agentId: employee.binding.agentId,
    target: "assigned_vm",
    expectedRevision: 0,
    changedAt: 8_001,
  });
  if (target.kind !== "assigned_vm") {
    throw new Error("fixture VM target missing");
  }
  const session = await store.createBrowserSession({
    userId: employee.user.id,
    tokenHash: "synthetic-recovery-session",
    createdAt: 9_000,
  });
  if (session.status !== "created") {
    throw new Error("fixture browser session missing");
  }
  const failure = {
    agentId: target.agentId,
    allocationId: target.allocationId,
    targetRevision: target.revision,
    credentialRevision: target.credentialRevision,
    failedAt: 10_000,
  };
  const commit = {
    ...identity,
    expectedBindingId: employee.binding.id,
    expectedSessionId: session.session.id,
    expectedCredentialRevision: target.credentialRevision,
    expectedAllocationId: target.allocationId,
    expectedTargetRevision: target.revision,
    remoteHomeDir: target.remoteHomeDir,
    remoteWorkspaceDir: target.remoteWorkspaceDir,
    credentialEnvelope: REPLACEMENT_ENVELOPE,
    checkedAt: 11_000,
  };
  return {
    store,
    admin,
    host,
    employee,
    identity,
    target,
    session: session.session,
    failure,
    commit,
  };
}

describe("SQLite VM credential recovery", () => {
  it("records one current failure, projects the saved registration, and isolates another owner", async () => {
    const f = await recoveryFixture();
    const other = await createActivePersonalAgent(f.store, "other.user");
    await f.store.commitPersonalVmSelection({
      actorUserId: other.user.id,
      agentId: other.binding.agentId,
      vmHostId: f.host.id,
      linuxAccount: "other.user",
      remoteHomeDir: "/home/other.user",
      remoteWorkspaceDir: "/home/other.user/workspace",
      credentialEnvelope: INITIAL_ENVELOPE,
      committedAt: 9_000,
    });
    for (const stale of [
      { ...f.failure, agentId: other.binding.agentId },
      { ...f.failure, allocationId: "previous-allocation" },
      { ...f.failure, targetRevision: f.failure.targetRevision + 1 },
      { ...f.failure, credentialRevision: f.failure.credentialRevision + 1 },
    ]) {
      await expect(f.store.recordVmAuthenticationFailure(stale)).resolves.toEqual({
        recorded: false,
      });
    }
    await expect(f.store.recordVmAuthenticationFailure(f.failure)).resolves.toEqual({
      recorded: true,
    });
    const audit = await f.store.listAuditEvents();
    await expect(f.store.recordVmAuthenticationFailure(f.failure)).resolves.toEqual({
      recorded: false,
    });
    expect(await f.store.listAuditEvents()).toEqual(audit);
    expect(await f.store.readEncryptedUserSshCredential(f.employee.user.id)).toMatchObject({
      revision: f.target.credentialRevision,
      status: "update_required",
      lastAuthFailureAt: 10_000,
    });
    expect(await f.store.getPersonalExecutionSettings(f.identity.agentId)).toMatchObject({
      allocation: {
        id: f.target.allocationId,
        status: "connection_required",
        failureCode: "vm_authentication_failed",
      },
    });
    expect(await f.store.getPersonalSavedVmConnections(f.identity)).toMatchObject([
      { status: "connection_required", failureCode: "vm_authentication_failed" },
    ]);
    expect(await f.store.readEncryptedUserSshCredential(other.user.id)).toMatchObject({
      status: "current",
      revision: 1,
    });
    await expect(
      f.store.recordVmConnectionResult({
        ...f.identity,
        expectedAllocationId: f.target.allocationId,
        expectedTargetRevision: f.target.revision,
        expectedCredentialRevision: f.target.credentialRevision,
        checkedAt: 10_001,
        result: {
          status: "ready",
          remoteHomeDir: f.target.remoteHomeDir,
          remoteWorkspaceDir: f.target.remoteWorkspaceDir,
        },
      }),
    ).rejects.toMatchObject({ code: "execution_target_conflict" });
    f.store.close?.();
  });

  it("atomically repairs active and saved credentials without reviving a stale password on switch", async () => {
    const f = await recoveryFixture();
    await f.store.recordVmAuthenticationFailure(f.failure);
    await f.store.commitPersonalVmCredential(f.commit);
    const repaired = await f.store.readEncryptedUserSshCredential(f.employee.user.id);
    expect(repaired).toMatchObject({
      status: "current",
      revision: f.target.credentialRevision + 1,
      ciphertext: REPLACEMENT_ENVELOPE.ciphertext,
    });
    expect(repaired).not.toHaveProperty("lastAuthFailureAt");
    const saved = await f.store.getPersonalSavedVmConnections(f.identity);
    const connection = saved[0];
    if (!connection) {
      throw new Error("repaired saved registration missing");
    }
    expect(connection.status).toBe("ready");
    expect(
      (
        await f.store.getSavedVmConnectionCredential({
          ...f.identity,
          connectionId: connection.id,
        })
      ).credentialEnvelope,
    ).toEqual(REPLACEMENT_ENVELOPE);
    await expect(f.store.recordVmAuthenticationFailure(f.failure)).resolves.toEqual({
      recorded: false,
    });
    await expect(f.store.commitPersonalVmCredential(f.commit)).rejects.toMatchObject({
      code: "execution_target_conflict",
    });
    await f.store.changePersonalExecutionTarget({
      agentId: f.identity.agentId,
      target: "platform_server",
      expectedRevision: f.target.revision,
      changedAt: 12_000,
    });
    await f.store.activatePersonalVmConnection({
      agentId: f.identity.agentId,
      connectionId: connection.id,
      expectedConnectionRevision: connection.revision,
      expectedRevision: f.target.revision + 1,
      changedAt: 12_001,
    });
    expect(await f.store.readEncryptedUserSshCredential(f.employee.user.id)).toMatchObject({
      status: "current",
      ciphertext: REPLACEMENT_ENVELOPE.ciphertext,
    });
    f.store.close?.();
  });

  it.each([
    "revoked session",
    "expired session",
    "disabled user",
    "disabled binding",
    "changed target",
    "changed credential",
  ] as const)(
    "rejects credential commit after %s without overwriting current state",
    async (reason) => {
      const f = await recoveryFixture();
      if (reason === "revoked session") {
        await f.store.revokeBrowserSession(f.session.id, 10_000);
      } else if (reason === "expired session") {
        f.commit.checkedAt = f.session.absoluteExpiresAt;
      } else if (reason === "disabled user") {
        await f.store.setManagedUserStatus({
          actorUserId: f.admin.user.id,
          targetUserId: f.employee.user.id,
          status: "disabled",
          changedAt: 10_000,
        });
      } else if (reason === "disabled binding") {
        await f.store.transitionAgent({
          bindingId: f.employee.binding.id,
          state: "disabled",
          changedAt: 10_000,
        });
      } else if (reason === "changed target") {
        await f.store.changePersonalExecutionTarget({
          agentId: f.identity.agentId,
          target: "platform_server",
          expectedRevision: f.target.revision,
          changedAt: 10_000,
        });
      } else {
        await f.store.replaceEncryptedUserSshCredential({
          actorUserId: f.employee.user.id,
          userId: f.employee.user.id,
          envelope: { ...INITIAL_ENVELOPE, ciphertext: new Uint8Array([3]) },
          replacedAt: 10_000,
        });
      }
      const before = await f.store.getPersonalExecutionSettings(f.identity.agentId);
      await expect(f.store.commitPersonalVmCredential(f.commit)).rejects.toMatchObject({
        code: "execution_target_conflict",
      });
      expect(await f.store.getPersonalExecutionSettings(f.identity.agentId)).toEqual(before);
      if (reason === "disabled user") {
        await expect(f.store.recordVmAuthenticationFailure(f.failure)).resolves.toEqual({
          recorded: false,
        });
        await f.store.setManagedUserStatus({
          actorUserId: f.admin.user.id,
          targetUserId: f.employee.user.id,
          status: "active",
          changedAt: 11_001,
        });
      }
      expect(
        (await f.store.readEncryptedUserSshCredential(f.employee.user.id))?.ciphertext,
      ).toEqual(new Uint8Array([reason === "changed credential" ? 3 : 1]));
      f.store.close?.();
    },
  );

  it.each(["user", "binding"] as const)(
    "rejects a delayed stored-credential connection result after its %s is disabled",
    async (owner) => {
      const f = await recoveryFixture();
      if (owner === "user") {
        await f.store.setManagedUserStatus({
          actorUserId: f.admin.user.id,
          targetUserId: f.employee.user.id,
          status: "disabled",
          changedAt: 10_000,
        });
      } else {
        await f.store.transitionAgent({
          bindingId: f.employee.binding.id,
          state: "disabled",
          changedAt: 10_000,
        });
      }
      const before = await f.store.getVmAllocationForAgent(f.identity.agentId);
      await expect(
        f.store.recordVmConnectionResult({
          ...f.identity,
          expectedAllocationId: f.target.allocationId,
          expectedTargetRevision: f.target.revision,
          expectedCredentialRevision: f.target.credentialRevision,
          checkedAt: 11_000,
          result: {
            status: "ready",
            remoteHomeDir: f.target.remoteHomeDir,
            remoteWorkspaceDir: f.target.remoteWorkspaceDir,
          },
        }),
      ).rejects.toMatchObject({ code: "execution_target_conflict" });
      expect(await f.store.getVmAllocationForAgent(f.identity.agentId)).toEqual(before);
      f.store.close?.();
    },
  );
});
