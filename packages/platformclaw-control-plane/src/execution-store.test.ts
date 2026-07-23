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
import type { ControlPlaneExecutionManagementStore } from "./execution-contracts.js";
import { InMemoryControlPlaneStore } from "./memory-store.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

type ExecutionTestStore = ControlPlaneStore &
  ControlPlaneExecutionManagementStore &
  ControlPlaneAuditReader & { close?: () => void };

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

function createMemoryStore(): ExecutionTestStore {
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

async function createActivePersonalAgent(store: ExecutionTestStore, accountId: string) {
  const { user } = await store.upsertPrincipal(principal(accountId), 1_000);
  const reserved = await store.reservePersonalAgent(user.id, 2_000);
  const binding = await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: 3_000,
  });
  return { user, binding };
}

async function prepareVm(store: ExecutionTestStore) {
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
