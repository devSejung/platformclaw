import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupExecutionStoreDirectories,
  createActivePersonalAgent,
  createSqliteStore,
  prepareVm,
} from "./execution-store.test-support.js";

afterEach(cleanupExecutionStoreDirectories);

function fixtureEntry<T>(entries: readonly T[], index: number): T {
  const entry = entries[index];
  if (entry === undefined) {
    throw new Error(`fixture entry missing at index ${index}`);
  }
  return entry;
}

describe("saved personal VM connections", () => {
  async function fixture() {
    const store = createSqliteStore();
    const { admin, endpoint, host } = await prepareVm(store);
    const employee = await createActivePersonalAgent(store, "saved.user");
    const hosts = [host];
    for (const index of [2, 3]) {
      hosts.push(
        await store.createVmHost({
          actorUserId: admin.user.id,
          endpointId: endpoint.id,
          label: `Development VM ${index}`,
          targetAddress: `192.0.2.${10 + index}`,
          createdAt: 6_000 + index,
        }),
      );
    }
    const identity = { actorUserId: employee.user.id, agentId: employee.binding.agentId };
    const save = async (index: number, expectedRevision: number) => {
      const vm = fixtureEntry(hosts, index);
      const candidate = await store.preparePersonalVmCandidate({
        ...identity,
        vmHostId: vm.id,
        linuxAccount: "saved.user",
      });
      return store.savePersonalVmConnection({
        ...identity,
        vmHostId: vm.id,
        linuxAccount: "saved.user",
        candidate,
        remoteHomeDir: `/home/vm${index + 1}/saved.user`,
        remoteWorkspaceDir: `/home/vm${index + 1}/saved.user/workspace`,
        credentialEnvelope: {
          ciphertext: new Uint8Array([index + 1]),
          nonce: new Uint8Array(12),
          authTag: new Uint8Array(16),
          keyId: `sha256:${"A".repeat(43)}`,
          formatVersion: 1,
        },
        expectedRevision,
        verifiedAt: 7_000 + index,
      });
    };
    const activate = async (connectionId: string) => {
      const settings = await store.getPersonalExecutionSettings(identity.agentId);
      const saved = (await store.getPersonalSavedVmConnections(identity)).find(
        (entry) => entry.id === connectionId,
      );
      if (!settings || !saved) {
        throw new Error("fixture VM connection missing");
      }
      return store.activatePersonalVmConnection({
        agentId: identity.agentId,
        connectionId,
        expectedRevision: settings.targetRevision,
        expectedConnectionRevision: saved.revision,
        changedAt: 8_000 + settings.targetRevision,
      });
    };
    return { store, admin, endpoint, employee, hosts, identity, save, activate };
  }

  it("switches three saved VMs atomically and preserves per-VM credentials and coding settings", async () => {
    const { store, identity, save, activate } = await fixture();
    const connections = [];
    for (const index of [0, 1, 2]) {
      connections.push(await save(index, 0));
    }
    const initialTarget = await activate(fixtureEntry(connections, 0).id);
    if (initialTarget.kind !== "assigned_vm") {
      throw new Error("initial VM target missing");
    }
    expect(initialTarget.targetId).toBe(fixtureEntry(connections, 0).id);
    let settings = await store.getPersonalExecutionSettings(identity.agentId);
    if (!settings) {
      throw new Error("execution settings missing");
    }
    await store.setPersonalCodingAgent({
      ...identity,
      expectedRevision: settings.targetRevision,
      configuration: { agent: "opencode", enabled: true, executablePath: "/home/vm1/bin/opencode" },
      updatedAt: 9_000,
    });
    for (const index of [1, 2, 0]) {
      const connection = fixtureEntry(connections, index);
      const target = await activate(connection.id);
      expect(target).toMatchObject({
        kind: "assigned_vm",
        targetId: connection.id,
        remoteWorkspaceDir: `/home/vm${index + 1}/saved.user/workspace`,
      });
      if (index === 0) {
        expect(target).not.toMatchObject({ allocationId: initialTarget.allocationId });
      }
      expect(
        (
          await store.readEncryptedUserSshCredential(
            (await store.getPersonalExecutionSettings(identity.agentId))?.userId ?? "",
          )
        )?.ciphertext,
      ).toEqual(new Uint8Array([index + 1]));
    }
    settings = await store.getPersonalExecutionSettings(identity.agentId);
    expect(
      settings?.codingAgents.find((entry) => entry.configuration.agent === "opencode"),
    ).toMatchObject({
      hasSavedConfiguration: true,
      configuration: { executablePath: "/home/vm1/bin/opencode" },
    });
    const saved = await store.getPersonalSavedVmConnections(identity);
    expect(saved).toHaveLength(3);
    expect(saved.filter((entry) => entry.active).map((entry) => entry.id)).toEqual([
      fixtureEntry(connections, 0).id,
    ]);
    if (!settings) {
      throw new Error("execution settings missing");
    }
    await store.changePersonalExecutionTarget({
      agentId: identity.agentId,
      target: "platform_server",
      expectedRevision: settings.targetRevision,
      changedAt: 10_000,
    });
    await activate(fixtureEntry(connections, 1).id);
    expect(await store.resolvePersonalExecutionTarget(identity.agentId)).toMatchObject({
      kind: "assigned_vm",
      remoteHomeDir: "/home/vm2/saved.user",
    });
    const credentialBefore = await store.readEncryptedUserSshCredential(settings.userId);
    await store.removePersonalSavedVmConnection({
      ...identity,
      connectionId: fixtureEntry(connections, 0).id,
      removedAt: 11_000,
    });
    expect(await store.readEncryptedUserSshCredential(settings.userId)).toEqual(credentialBefore);
    await expect(
      store.activatePersonalVmConnection({
        agentId: identity.agentId,
        connectionId: fixtureEntry(connections, 2).id,
        expectedRevision: 0,
        expectedConnectionRevision: fixtureEntry(connections, 2).revision,
        changedAt: 12_000,
      }),
    ).rejects.toMatchObject({ code: "execution_target_conflict" });
    store.close?.();
  });

  it("keeps the active VM on destination auth failure and enforces ownership, disable and revoke", async () => {
    const { store, admin, hosts, identity, save, activate } = await fixture();
    const first = await save(0, 0);
    const second = await save(1, 0);
    const third = await save(2, 0);
    await activate(first.id);
    const before = await store.resolvePersonalExecutionTarget(identity.agentId);
    await store.markSavedVmConnectionUpdateRequired({
      ...identity,
      connectionId: second.id,
      expectedConnectionRevision: second.revision,
      failedAt: 10_000,
    });
    expect(await store.resolvePersonalExecutionTarget(identity.agentId)).toEqual(before);
    await expect(
      store.getSavedVmConnectionCredential({ ...identity, connectionId: second.id }),
    ).rejects.toThrow("reconnect this VM");
    await expect(
      store.getPersonalSavedVmConnections({
        actorUserId: admin.user.id,
        agentId: identity.agentId,
      }),
    ).rejects.toThrow("owned personal VM");
    const intruderCandidate = await store.preparePersonalVmCandidate({
      actorUserId: admin.user.id,
      agentId: admin.binding.agentId,
      vmHostId: fixtureEntry(hosts, 1).id,
      linuxAccount: "saved.user",
    });
    await expect(
      store.savePersonalVmConnection({
        actorUserId: admin.user.id,
        agentId: admin.binding.agentId,
        vmHostId: fixtureEntry(hosts, 1).id,
        linuxAccount: "saved.user",
        candidate: intruderCandidate,
        remoteHomeDir: "/home/intruder",
        remoteWorkspaceDir: "/home/intruder/workspace",
        credentialEnvelope: {
          ciphertext: new Uint8Array([9]),
          nonce: new Uint8Array(12),
          authTag: new Uint8Array(16),
          keyId: `sha256:${"A".repeat(43)}`,
          formatVersion: 1,
        },
        expectedRevision: 0,
        verifiedAt: 10_001,
      }),
    ).rejects.toMatchObject({ code: "vm_allocation_conflict" });
    await store.disableVmHost({
      actorUserId: admin.user.id,
      vmHostId: fixtureEntry(hosts, 2).id,
      disabledAt: 11_000,
    });
    expect(
      (await store.getPersonalSavedVmConnections(identity)).find((entry) => entry.id === third.id)
        ?.status,
    ).toBe("unavailable");
    await store.updateVmHost({
      actorUserId: admin.user.id,
      vmHostId: fixtureEntry(hosts, 2).id,
      endpointId: fixtureEntry(hosts, 2).endpointId,
      label: "Changed VM",
      targetAddress: "192.0.2.99",
      updatedAt: 11_001,
    });
    await store.enableVmHost({
      actorUserId: admin.user.id,
      vmHostId: fixtureEntry(hosts, 2).id,
      enabledAt: 11_002,
    });
    expect(
      (await store.getPersonalSavedVmConnections(identity)).find((entry) => entry.id === third.id),
    ).toMatchObject({ status: "connection_required", failureCode: "vm_configuration_changed" });
    await expect(save(2, before.revision)).rejects.toThrow(
      "remove this saved connection and register it again",
    );
    const snapshot = await store.getVmAdministrationSnapshot(admin.user.id);
    expect(snapshot.savedConnections).toHaveLength(3);
    await store.removePersonalSavedVmConnection({
      actorUserId: admin.user.id,
      agentId: identity.agentId,
      connectionId: third.id,
      removedAt: 12_000,
    });
    const settings = await store.getPersonalExecutionSettings(identity.agentId);
    if (!settings?.allocation) {
      throw new Error("active allocation missing");
    }
    await store.changePersonalExecutionTarget({
      agentId: identity.agentId,
      target: "platform_server",
      expectedRevision: settings.targetRevision,
      changedAt: 12_001,
    });
    await store.revokeVmAllocationAsAdmin({
      actorUserId: admin.user.id,
      allocationId: settings.allocation.id,
      revokedAt: 12_002,
    });
    expect((await store.getPersonalSavedVmConnections(identity)).map((entry) => entry.id)).toEqual([
      second.id,
    ]);
    const current = await store.getPersonalExecutionSettings(identity.agentId);
    if (!current) {
      throw new Error("execution settings missing after revocation");
    }
    const renewed = await save(0, current.targetRevision);
    expect(renewed.id).not.toBe(first.id);
    expect(await activate(renewed.id)).toMatchObject({ targetId: renewed.id });
    store.close?.();
  });

  it("renames active SafeConnect without changing security identity or connected allocations", async () => {
    const { store, admin, endpoint, identity, save, activate } = await fixture();
    const saved = await save(0, 0);
    await activate(saved.id);
    const before = await store.resolvePersonalExecutionTarget(identity.agentId);
    const renamed = await store.renameSafeConnectEndpoint({
      actorUserId: admin.user.id,
      endpointId: endpoint.id,
      label: "Renamed SafeConnect",
      updatedAt: 10_000,
    });
    expect(renamed).toEqual({ ...endpoint, label: "Renamed SafeConnect", updatedAt: 10_000 });
    expect(await store.resolvePersonalExecutionTarget(identity.agentId)).toEqual({
      ...before,
      safeConnectLabel: "Renamed SafeConnect",
    });
    await expect(
      store.renameSafeConnectEndpoint({
        ...identity,
        endpointId: endpoint.id,
        label: "Unauthorized",
        updatedAt: 10_001,
      }),
    ).rejects.toThrow("active administrator required");
    await expect(
      store.updateSafeConnectEndpoint({
        actorUserId: admin.user.id,
        endpointId: endpoint.id,
        label: renamed.label,
        host: endpoint.host,
        port: endpoint.port,
        adDomain: "changed.example.test",
        updatedAt: 10_002,
      }),
    ).rejects.toThrow("disable this SafeConnect endpoint");
    const renameEvent = (await store.listAuditEvents()).find(
      (entry) => entry.eventType === "safeconnect.endpoint.renamed",
    );
    expect(renameEvent).toMatchObject({ targetId: endpoint.id });
    expect(renameEvent).not.toHaveProperty("details");
    store.close?.();
  });

  it("rejects a stale credential verification before changing the current VM credential", async () => {
    const { store, identity, save, activate } = await fixture();
    const first = await save(0, 0);
    const second = await save(1, 0);
    await activate(first.id);
    const old = await store.getPersonalExecutionSettings(identity.agentId);
    if (!old?.allocation) {
      throw new Error("initial allocation missing");
    }
    await activate(second.id);
    const credentialBefore = await store.readEncryptedUserSshCredential(old.userId);
    const targetBefore = await store.resolvePersonalExecutionTarget(identity.agentId);
    await expect(
      store.commitPersonalVmCredential({
        ...identity,
        expectedAllocationId: old.allocation.id,
        expectedTargetRevision: old.targetRevision,
        remoteHomeDir: "/home/old",
        remoteWorkspaceDir: "/home/old/workspace",
        credentialEnvelope: {
          ciphertext: new Uint8Array([99]),
          nonce: new Uint8Array(12),
          authTag: new Uint8Array(16),
          keyId: `sha256:${"A".repeat(43)}`,
          formatVersion: 1,
        },
        checkedAt: 20_000,
      }),
    ).rejects.toMatchObject({ code: "execution_target_conflict" });
    expect(await store.readEncryptedUserSshCredential(old.userId)).toEqual(credentialBefore);
    expect(await store.resolvePersonalExecutionTarget(identity.agentId)).toEqual(targetBefore);
    store.close?.();
  });

  it("requires a new registration before an administrator changes its Linux account", async () => {
    const { store, admin, hosts, identity, save, activate } = await fixture();
    const first = await save(0, 0);
    const second = await save(1, 0);
    await activate(first.id);
    let settings = await store.getPersonalExecutionSettings(identity.agentId);
    if (!settings) {
      throw new Error("execution settings missing");
    }
    await store.setPersonalCodingAgent({
      ...identity,
      expectedRevision: settings.targetRevision,
      configuration: {
        agent: "opencode",
        enabled: true,
        executablePath: "/home/old-account/bin/opencode",
      },
      updatedAt: 9_000,
    });
    await activate(second.id);
    settings = await store.getPersonalExecutionSettings(identity.agentId);
    if (!settings) {
      throw new Error("execution settings missing");
    }
    await store.changePersonalExecutionTarget({
      agentId: identity.agentId,
      target: "platform_server",
      expectedRevision: settings.targetRevision,
      changedAt: 10_000,
    });
    await store.releasePersonalVmAccess({ ...identity, releasedAt: 10_001 });
    const assignment = {
      actorUserId: admin.user.id,
      agentId: identity.agentId,
      vmHostId: fixtureEntry(hosts, 0).id,
      linuxAccount: "new.account",
      assignedAt: 10_002,
    };
    await expect(store.assignVmToPersonalAgent(assignment)).rejects.toThrow(
      "remove this saved connection and register it again",
    );
    await store.removePersonalSavedVmConnection({
      ...identity,
      connectionId: first.id,
      removedAt: 10_003,
    });
    const assigned = await store.assignVmToPersonalAgent(assignment);
    expect(await store.getPersonalSavedVmConnections(identity)).toMatchObject([
      { id: assigned.id, linuxAccount: "new.account", status: "connection_required" },
    ]);
    expect(assigned.id).not.toBe(first.id);
    await expect(
      store.getSavedVmConnectionCredential({ ...identity, connectionId: first.id }),
    ).rejects.toThrow("reconnect this VM");
    expect(
      (await store.getPersonalExecutionSettings(identity.agentId))?.codingAgents.every(
        (entry) => !entry.hasSavedConfiguration,
      ),
    ).toBe(true);
    store.close?.();
  });

  it("never retargets a saved registration to another account or verified filesystem root", async () => {
    const { store, hosts, identity, save, activate } = await fixture();
    const first = await save(0, 0);
    const saved = await store.getSavedVmConnectionCredential({
      ...identity,
      connectionId: first.id,
    });
    const original = await store.getPersonalSavedVmConnections(identity);
    const attempts = [
      {
        linuxAccount: "new.account",
        remoteHomeDir: "/home/vm1/saved.user",
        remoteWorkspaceDir: "/home/vm1/saved.user/workspace",
      },
      {
        linuxAccount: "saved.user",
        remoteHomeDir: "/home/moved",
        remoteWorkspaceDir: "/home/moved/workspace",
      },
      {
        linuxAccount: "saved.user",
        remoteHomeDir: "/home/vm1/saved.user",
        remoteWorkspaceDir: "/home/vm1/saved.user/other",
      },
    ];
    for (const attempt of attempts) {
      const candidate = await store.preparePersonalVmCandidate({
        ...identity,
        vmHostId: fixtureEntry(hosts, 0).id,
        linuxAccount: attempt.linuxAccount,
      });
      await expect(
        store.savePersonalVmConnection({
          ...identity,
          vmHostId: fixtureEntry(hosts, 0).id,
          ...attempt,
          credentialEnvelope: saved.credentialEnvelope,
          candidate,
          expectedRevision: 0,
          verifiedAt: 10_000,
        }),
      ).rejects.toThrow("remove this saved connection and register it again");
    }
    expect(await store.getPersonalSavedVmConnections(identity)).toEqual(original);
    await activate(first.id);
    const settings = await store.getPersonalExecutionSettings(identity.agentId);
    if (!settings?.allocation) {
      throw new Error("active VM allocation missing");
    }
    const credential = await store.readEncryptedUserSshCredential(settings.userId);
    await expect(
      store.commitPersonalVmCredential({
        ...identity,
        expectedAllocationId: settings.allocation.id,
        expectedTargetRevision: settings.targetRevision,
        remoteHomeDir: "/home/moved",
        remoteWorkspaceDir: "/home/moved/workspace",
        credentialEnvelope: saved.credentialEnvelope,
        checkedAt: 11_000,
      }),
    ).rejects.toThrow("remove this saved connection and register it again");
    expect(await store.readEncryptedUserSshCredential(settings.userId)).toEqual(credential);
    expect(await store.resolvePersonalExecutionTarget(identity.agentId)).toMatchObject({
      targetId: first.id,
      remoteHomeDir: "/home/vm1/saved.user",
    });
    store.close?.();
  });

  it("erases the selected credential when its registration is released from Basic", async () => {
    const { store, identity, save, activate } = await fixture();
    const first = await save(0, 0);
    await activate(first.id);
    const settings = await store.getPersonalExecutionSettings(identity.agentId);
    if (!settings) {
      throw new Error("execution settings missing");
    }
    await store.changePersonalExecutionTarget({
      agentId: identity.agentId,
      target: "platform_server",
      expectedRevision: settings.targetRevision,
      changedAt: 20_000,
    });
    await store.removePersonalSavedVmConnection({
      ...identity,
      connectionId: first.id,
      removedAt: 20_001,
    });
    expect(await store.readEncryptedUserSshCredential(settings.userId)).toBeNull();
    expect(await store.getPersonalSavedVmConnections(identity)).toEqual([]);
    store.close?.();
  });

  it("lets administrators reclaim detached reservations from disabled users", async () => {
    const { store, admin, employee, hosts, identity, save, activate } = await fixture();
    const first = await save(0, 0);
    const second = await save(1, 0);
    await activate(first.id);
    await activate(second.id);
    await store.setManagedUserStatus({
      actorUserId: admin.user.id,
      targetUserId: employee.user.id,
      status: "disabled",
      changedAt: 20_000,
    });
    await expect(
      store.removePersonalSavedVmConnection({
        ...identity,
        connectionId: first.id,
        removedAt: 20_001,
      }),
    ).rejects.toThrow("owned personal VM connections are unavailable");
    await store.removePersonalSavedVmConnection({
      actorUserId: admin.user.id,
      agentId: identity.agentId,
      connectionId: first.id,
      removedAt: 20_002,
    });
    const snapshot = await store.getVmAdministrationSnapshot(admin.user.id);
    expect(snapshot.savedConnections?.map((entry) => entry.id)).toEqual([second.id]);
    await expect(
      store.removePersonalSavedVmConnection({
        actorUserId: admin.user.id,
        agentId: identity.agentId,
        connectionId: second.id,
        removedAt: 20_003,
      }),
    ).rejects.toThrow("switch work location before removing this VM");
    const replacement = await createActivePersonalAgent(store, "replacement.user");
    await expect(
      store.assignVmToPersonalAgent({
        actorUserId: admin.user.id,
        agentId: replacement.binding.agentId,
        vmHostId: fixtureEntry(hosts, 0).id,
        linuxAccount: "saved.user",
        assignedAt: 20_004,
      }),
    ).resolves.toMatchObject({ linuxAccount: "saved.user" });
    store.close?.();
  });
});
