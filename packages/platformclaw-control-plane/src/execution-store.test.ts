import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ControlPlaneAuditReader,
  ControlPlaneIdFactory,
  ControlPlaneStore,
  EnterprisePrincipal,
} from "./contracts.js";
import type {
  ControlPlaneEmployeeExecutionStore,
  ControlPlaneAtomicVmCredentialStore,
  ControlPlaneExecutionManagementStore,
  ControlPlaneExecutionTargetStore,
  ControlPlaneVmLifecycleStore,
  ControlPlaneVmSelfServiceStore,
} from "./execution-contracts.js";
import { InMemoryControlPlaneStore } from "./memory-store.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";
import type { ControlPlaneSshCredentialEnvelopeStore } from "./ssh-credential-contracts.js";

type ExecutionManagementTestStore = ControlPlaneStore &
  ControlPlaneExecutionManagementStore &
  ControlPlaneAuditReader & { close?: () => void };

type ExecutionTestStore = ExecutionManagementTestStore &
  ControlPlaneEmployeeExecutionStore &
  ControlPlaneExecutionTargetStore &
  ControlPlaneAtomicVmCredentialStore &
  ControlPlaneSshCredentialEnvelopeStore &
  ControlPlaneVmLifecycleStore &
  ControlPlaneVmSelfServiceStore;

const temporaryDirectories: string[] = [];

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

const testHostKeyBlob = Buffer.concat([
  sshString(Buffer.from("ssh-ed25519")),
  sshString(Buffer.alloc(32, 7)),
]);
const testHostKey = {
  algorithm: "ssh-ed25519",
  publicKey: testHostKeyBlob.toString("base64"),
  fingerprint: `SHA256:${createHash("sha256")
    .update(testHostKeyBlob)
    .digest("base64")
    .replace(/=+$/u, "")}`,
};

function createIdFactory(): ControlPlaneIdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}-${++sequence}`;
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
    subject: `subject:${accountId}`,
    accountId,
    employeeId: accountId,
  };
}

function createMemoryStore(): ExecutionManagementTestStore {
  return new InMemoryControlPlaneStore({
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin.user"],
    idFactory: createIdFactory(),
  });
}

function createSqliteStore(): ExecutionTestStore {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-execution-store-"));
  temporaryDirectories.push(directory);
  return new SqliteControlPlaneStore({
    databasePath: join(directory, "state", "platformclaw-control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin.user"],
    idFactory: createIdFactory(),
  });
}

async function createActivePersonalAgent(store: ExecutionManagementTestStore, accountId: string) {
  const { user } = await store.upsertPrincipal(principal(accountId), 1_000);
  const reserved = await store.reservePersonalAgent(user.id, 2_000);
  const binding = await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: 3_000,
  });
  return { user, binding };
}

async function prepareVm(store: ExecutionManagementTestStore) {
  const admin = await createActivePersonalAgent(store, "admin.user");
  const endpoint = await store.createSafeConnectEndpoint({
    actorUserId: admin.user.id,
    label: "SafeConnect primary",
    host: "safeconnect.example.test",
    port: 44_422,
    adDomain: "example.test",
    createdAt: 4_000,
  });
  await expect(
    store.createVmHost({
      actorUserId: admin.user.id,
      endpointId: endpoint.id,
      label: "Development VM",
      targetAddress: "192.0.2.10",
      createdAt: 4_001,
    }),
  ).rejects.toThrow("active, pinned SafeConnect endpoint");
  await expect(
    store.approveSafeConnectHostKey({
      actorUserId: admin.user.id,
      endpointId: endpoint.id,
      algorithm: testHostKey.algorithm,
      publicKey: testHostKey.publicKey,
      fingerprint: "SHA256:wrong-fingerprint",
      approvedAt: 4_002,
    }),
  ).rejects.toThrow("approved host key fingerprint does not match public key");
  const approved = await store.approveSafeConnectHostKey({
    actorUserId: admin.user.id,
    endpointId: endpoint.id,
    algorithm: testHostKey.algorithm,
    publicKey: testHostKey.publicKey,
    fingerprint: testHostKey.fingerprint,
    approvedAt: 5_000,
  });
  const host = await store.createVmHost({
    actorUserId: admin.user.id,
    endpointId: approved.id,
    label: "Development VM",
    targetAddress: "192.0.2.10",
    createdAt: 6_000,
  });
  return { admin, endpoint: approved, host };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each([
  ["memory", createMemoryStore],
  ["sqlite", createSqliteStore],
] as const)("%s execution management store", (_name, createStore) => {
  it("creates a server-default profile and requires explicit host-key approval", async () => {
    const store = createStore();
    const { admin, endpoint } = await prepareVm(store);

    await expect(store.getPersonalExecutionProfile(admin.binding.agentId)).resolves.toEqual({
      agentBindingId: admin.binding.id,
      activeTarget: "platform_server",
      targetRevision: 0,
      updatedAt: 2_000,
    });
    expect(endpoint).toMatchObject({
      adDomain: "example.test",
      host: "safeconnect.example.test",
      status: "active",
      hostKeyApprovedByUserId: admin.user.id,
      hostKeyFingerprint: testHostKey.fingerprint,
    });
    await expect(
      store.createSafeConnectEndpoint({
        actorUserId: admin.user.id,
        label: "Duplicate endpoint alias",
        host: "SafeConnect.Example.Test.",
        port: 44_422,
        adDomain: "EXAMPLE.TEST.",
        createdAt: 6_000,
      }),
    ).rejects.toMatchObject({ code: "safeconnect_endpoint_conflict" });
    await expect(
      store.createSafeConnectEndpoint({
        actorUserId: admin.user.id,
        label: "Invalid endpoint",
        host: "user@safeconnect.example.test:44422",
        port: 44_422,
        adDomain: "example.test",
        createdAt: 6_000,
      }),
    ).rejects.toThrow("endpoint.host must be a valid DNS name");
    const dnsHost = await store.createVmHost({
      actorUserId: admin.user.id,
      endpointId: endpoint.id,
      label: "DNS VM",
      targetAddress: "VM.Example.Test.",
      createdAt: 6_001,
    });
    expect(dnsHost.targetAddress).toBe("vm.example.test");
    await expect(
      store.createVmHost({
        actorUserId: admin.user.id,
        endpointId: endpoint.id,
        label: "Duplicate DNS VM",
        targetAddress: "vm.example.test",
        createdAt: 6_002,
      }),
    ).rejects.toMatchObject({ code: "vm_host_conflict" });
    expect(
      (await store.listAuditEvents())
        .map((event) => event.eventType)
        .filter((eventType) => eventType.startsWith("safeconnect.") || eventType.startsWith("vm.")),
    ).toEqual([
      "vm.host.created",
      "vm.host.created",
      "safeconnect.host-key.approved",
      "safeconnect.endpoint.created",
    ]);
    store.close?.();
  });

  it("isolates personal allocations and blocks duplicate Linux-account ownership", async () => {
    const store = createStore();
    const { admin, host } = await prepareVm(store);
    const first = await createActivePersonalAgent(store, "first.user");
    const second = await createActivePersonalAgent(store, "second.user");
    const allocation = await store.assignVmToPersonalAgent({
      actorUserId: admin.user.id,
      agentId: first.binding.agentId,
      vmHostId: host.id,
      linuxAccount: "linux-user",
      assignedAt: 7_000,
    });

    await expect(store.getVmAllocationForAgent(first.binding.agentId)).resolves.toEqual(allocation);
    await expect(store.getVmAllocationForAgent(second.binding.agentId)).resolves.toBeNull();
    await expect(
      store.assignVmToPersonalAgent({
        actorUserId: admin.user.id,
        agentId: second.binding.agentId,
        vmHostId: host.id,
        linuxAccount: "linux-user",
        assignedAt: 7_001,
      }),
    ).rejects.toMatchObject({ code: "vm_allocation_conflict" });
    await expect(
      store.assignVmToPersonalAgent({
        actorUserId: admin.user.id,
        agentId: first.binding.agentId,
        vmHostId: host.id,
        linuxAccount: "other-linux-user",
        assignedAt: 7_002,
      }),
    ).rejects.toMatchObject({ code: "vm_allocation_conflict" });
    store.close?.();
  });

  it("returns an admin-only VM administration snapshot", async () => {
    const store = createStore();
    const { admin, endpoint, host } = await prepareVm(store);
    const employee = await createActivePersonalAgent(store, "person.one");
    const allocation = await store.assignVmToPersonalAgent({
      actorUserId: admin.user.id,
      agentId: employee.binding.agentId,
      vmHostId: host.id,
      linuxAccount: "person.one",
      assignedAt: 7_000,
    });

    await expect(store.getVmAdministrationSnapshot(employee.user.id)).rejects.toThrow(
      "active administrator required",
    );
    await expect(store.getVmAdministrationSnapshot(admin.user.id)).resolves.toMatchObject({
      endpoints: [{ id: endpoint.id, label: "SafeConnect primary", status: "active" }],
      hosts: [{ id: host.id, label: "Development VM", status: "active" }],
      agents: [
        { accountId: "admin.user", agentId: admin.binding.agentId },
        {
          accountId: "person.one",
          agentId: employee.binding.agentId,
          allocationId: allocation.id,
        },
      ],
      allocations: [
        {
          id: allocation.id,
          accountId: "person.one",
          agentId: employee.binding.agentId,
          linuxAccount: "person.one",
          vmLabel: "Development VM",
        },
      ],
    });
    store.close?.();
  });

  it("rejects Knox-room allocation and non-admin infrastructure changes", async () => {
    const store = createStore();
    const { admin, host } = await prepareVm(store);
    const member = await createActivePersonalAgent(store, "member.user");
    const room = await store.reserveKnoxRoomAgent({
      accountId: "knox-account",
      roomId: "room-1",
      reservedAt: 8_000,
    });
    await store.transitionAgent({
      bindingId: room.binding.id,
      state: "active",
      changedAt: 8_001,
    });

    await expect(
      store.assignVmToPersonalAgent({
        actorUserId: admin.user.id,
        agentId: room.binding.agentId,
        vmHostId: host.id,
        linuxAccount: "room-user",
        assignedAt: 8_002,
      }),
    ).rejects.toThrow("active personal agent not found");
    await expect(
      store.createSafeConnectEndpoint({
        actorUserId: member.user.id,
        label: "unauthorized",
        host: "other.example.test",
        port: 22,
        adDomain: "example.test",
        createdAt: 8_003,
      }),
    ).rejects.toThrow("active administrator required");
    store.close?.();
  });
});

describe("Knox room execution target", () => {
  it("keeps an active room on the Docker-backed platform server", async () => {
    const store = createSqliteStore();
    const reserved = await store.reserveKnoxRoomAgent({
      accountId: "knox",
      roomId: "room-1",
      reservedAt: 1_000,
    });
    await store.transitionAgent({
      bindingId: reserved.binding.id,
      state: "active",
      changedAt: 1_001,
    });

    await expect(store.resolveExecutionTarget(reserved.binding.agentId)).resolves.toEqual({
      kind: "platform_server",
      agentId: reserved.binding.agentId,
      targetId: "platform-server",
      revision: 0,
    });
    store.close?.();
  });
});

describe("SQLite employee execution store", () => {
  it("supports self-service VM selection, replacement, release, and soft-disable lifecycle", async () => {
    const store = createSqliteStore();
    const { admin, endpoint, host } = await prepareVm(store);
    const employee = await createActivePersonalAgent(store, "person.one");

    await expect(
      store.getPersonalVmCatalog({
        actorUserId: employee.user.id,
        agentId: employee.binding.agentId,
      }),
    ).resolves.toEqual({
      accountId: "person.one",
      hosts: [{ id: host.id, label: "Development VM" }],
    });
    const candidate = await store.preparePersonalVmCandidate({
      actorUserId: employee.user.id,
      agentId: employee.binding.agentId,
      vmHostId: host.id,
      linuxAccount: "custom-linux-user",
    });
    expect(candidate).toMatchObject({
      allocationId: `candidate:${host.id}`,
      adAccount: "person.one",
      linuxAccount: "custom-linux-user",
      targetAddress: "192.0.2.10",
    });
    await expect(store.getVmAllocationForAgent(employee.binding.agentId)).resolves.toBeNull();

    const selection = {
      actorUserId: employee.user.id,
      agentId: employee.binding.agentId,
      vmHostId: host.id,
      linuxAccount: candidate.linuxAccount,
      remoteHomeDir: "/users/custom-linux-user",
      remoteWorkspaceDir: "/users/custom-linux-user/.platformclaw/workspace",
      committedAt: 7_000,
    };
    await expect(
      store.commitPersonalVmSelection({
        ...selection,
        credentialEnvelope: {
          ciphertext: new Uint8Array([1]),
          nonce: new Uint8Array(12),
          authTag: new Uint8Array(16),
          keyId: "invalid",
          formatVersion: 1,
        },
      }),
    ).rejects.toThrow("key id is invalid");
    await expect(store.getVmAllocationForAgent(employee.binding.agentId)).resolves.toBeNull();

    const allocation = await store.commitPersonalVmSelection({
      ...selection,
      credentialEnvelope: {
        ciphertext: new Uint8Array([1]),
        nonce: new Uint8Array(12),
        authTag: new Uint8Array(16),
        keyId: `sha256:${"A".repeat(43)}`,
        formatVersion: 1,
      },
    });
    await expect(
      store.getPersonalExecutionSettings(employee.binding.agentId),
    ).resolves.toMatchObject({
      allocation: {
        id: allocation.id,
        vmHostId: host.id,
        linuxAccount: "custom-linux-user",
        status: "ready",
      },
    });
    await expect(
      store.getUserSshCredentialMetadata({
        actorUserId: employee.user.id,
        userId: employee.user.id,
      }),
    ).resolves.toMatchObject({ status: "current", revision: 1 });
    await expect(
      store.disableVmHost({ actorUserId: admin.user.id, vmHostId: host.id, disabledAt: 7_001 }),
    ).rejects.toThrow("release every active assignment");

    await expect(
      store.releasePersonalVmAccess({
        actorUserId: employee.user.id,
        agentId: employee.binding.agentId,
        releasedAt: 7_002,
      }),
    ).resolves.toMatchObject({ id: allocation.id, status: "revoked" });
    await expect(
      store.getUserSshCredentialMetadata({
        actorUserId: employee.user.id,
        userId: employee.user.id,
      }),
    ).resolves.toBeNull();
    await expect(
      store.disableVmHost({ actorUserId: admin.user.id, vmHostId: host.id, disabledAt: 7_003 }),
    ).resolves.toMatchObject({ id: host.id, status: "disabled" });
    await expect(
      store.disableSafeConnectEndpoint({
        actorUserId: admin.user.id,
        endpointId: endpoint.id,
        disabledAt: 7_004,
      }),
    ).resolves.toMatchObject({ id: endpoint.id, status: "disabled" });
    store.close?.();
  });

  it("prepares a VM and changes targets with an optimistic revision", async () => {
    const store = createSqliteStore();
    const { admin, host } = await prepareVm(store);
    const employee = await createActivePersonalAgent(store, "person.one");
    const allocation = await store.assignVmToPersonalAgent({
      actorUserId: admin.user.id,
      agentId: employee.binding.agentId,
      vmHostId: host.id,
      linuxAccount: "person.one",
      assignedAt: 9_000,
    });

    await expect(
      store.getPersonalExecutionSettings(employee.binding.agentId),
    ).resolves.toMatchObject({
      userId: employee.user.id,
      activeTarget: "platform_server",
      targetRevision: 0,
      allocation: { id: allocation.id, status: "assigned", vmLabel: "Development VM" },
    });
    await expect(
      store.changePersonalExecutionTarget({
        agentId: employee.binding.agentId,
        target: "assigned_vm",
        expectedRevision: 0,
        changedAt: 9_001,
      }),
    ).rejects.toThrow("not ready");

    await expect(
      store.recordVmConnectionResult({
        actorUserId: employee.user.id,
        agentId: employee.binding.agentId,
        expectedAllocationId: "reassigned-allocation",
        expectedTargetRevision: 0,
        checkedAt: 9_001,
        result: {
          status: "ready",
          remoteHomeDir: "/users/person.one",
          remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
        },
      }),
    ).rejects.toMatchObject({ code: "execution_target_conflict" });

    await store.recordVmConnectionResult({
      actorUserId: employee.user.id,
      agentId: employee.binding.agentId,
      expectedAllocationId: allocation.id,
      expectedTargetRevision: 0,
      checkedAt: 9_002,
      result: {
        status: "ready",
        remoteHomeDir: "/users/person.one",
        remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
      },
    });
    await store.replaceEncryptedUserSshCredential({
      actorUserId: employee.user.id,
      userId: employee.user.id,
      envelope: {
        ciphertext: new Uint8Array([1]),
        nonce: new Uint8Array(12),
        authTag: new Uint8Array(16),
        keyId: `sha256:${"A".repeat(43)}`,
        formatVersion: 1,
      },
      replacedAt: 9_002,
    });
    await expect(
      store.resolveAssignedVmConnectionTarget(employee.binding.agentId),
    ).resolves.toMatchObject({
      userId: employee.user.id,
      allocationStatus: "ready",
      linuxAccount: "person.one",
    });
    await expect(
      store.changePersonalExecutionTarget({
        agentId: employee.binding.agentId,
        target: "assigned_vm",
        expectedRevision: 0,
        changedAt: 9_003,
      }),
    ).resolves.toMatchObject({ kind: "assigned_vm", revision: 1 });
    expect(
      (await store.listAuditEvents()).find(
        (event) => event.eventType === "execution.target.changed",
      ),
    ).toMatchObject({ actorUserId: employee.user.id, targetId: employee.binding.id });
    await expect(
      store.changePersonalExecutionTarget({
        agentId: employee.binding.agentId,
        target: "platform_server",
        expectedRevision: 0,
        changedAt: 9_004,
      }),
    ).rejects.toMatchObject({ code: "execution_target_conflict" });
    store.close?.();
  });

  it("repairs and re-enables disabled endpoints and VM hosts without replacing their records", async () => {
    const store = createSqliteStore();
    const { admin, endpoint, host } = await prepareVm(store);

    await store.disableVmHost({
      actorUserId: admin.user.id,
      vmHostId: host.id,
      disabledAt: 7_000,
    });
    await store.disableSafeConnectEndpoint({
      actorUserId: admin.user.id,
      endpointId: endpoint.id,
      disabledAt: 7_001,
    });
    const updatedEndpoint = await store.updateSafeConnectEndpoint({
      actorUserId: admin.user.id,
      endpointId: endpoint.id,
      label: "SafeConnect repaired",
      host: "safeconnect-new.example.test",
      port: 44_423,
      adDomain: "example.test",
      updatedAt: 7_002,
    });
    expect(updatedEndpoint).toMatchObject({
      id: endpoint.id,
      label: "SafeConnect repaired",
      host: "safeconnect-new.example.test",
      port: 44_423,
      status: "pending",
    });
    expect(updatedEndpoint.hostKeyFingerprint).toBeUndefined();
    await expect(
      store.enableSafeConnectEndpoint({
        actorUserId: admin.user.id,
        endpointId: endpoint.id,
        enabledAt: 7_003,
      }),
    ).rejects.toThrow("approve the SafeConnect host key");

    await store.approveSafeConnectHostKey({
      actorUserId: admin.user.id,
      endpointId: endpoint.id,
      ...testHostKey,
      approvedAt: 7_004,
    });
    await expect(
      store.approveSafeConnectHostKey({
        actorUserId: admin.user.id,
        endpointId: endpoint.id,
        ...testHostKey,
        approvedAt: 7_005,
      }),
    ).resolves.toMatchObject({ id: endpoint.id, status: "active" });
    const updatedHost = await store.updateVmHost({
      actorUserId: admin.user.id,
      vmHostId: host.id,
      endpointId: endpoint.id,
      label: "Development VM repaired",
      targetAddress: "192.0.2.11",
      updatedAt: 7_006,
    });
    expect(updatedHost).toMatchObject({
      id: host.id,
      label: "Development VM repaired",
      targetAddress: "192.0.2.11",
      status: "disabled",
    });
    await expect(
      store.enableVmHost({
        actorUserId: admin.user.id,
        vmHostId: host.id,
        enabledAt: 7_007,
      }),
    ).resolves.toMatchObject({ id: host.id, status: "active" });

    const snapshot = await store.getVmAdministrationSnapshot(admin.user.id);
    expect(snapshot.endpoints).toHaveLength(1);
    expect(snapshot.hosts).toHaveLength(1);
    store.close?.();
  });
});
