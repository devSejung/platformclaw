import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type {
  ControlPlaneAuditReader,
  ControlPlaneIdFactory,
  ControlPlaneManagementStore,
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
  ControlPlaneSavedVmConnectionStore,
} from "./execution-contracts.js";
import { InMemoryControlPlaneStore } from "./memory-store.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";
import type { ControlPlaneSshCredentialEnvelopeStore } from "./ssh-credential-contracts.js";

type ExecutionManagementTestStore = ControlPlaneStore &
  ControlPlaneExecutionManagementStore &
  ControlPlaneAuditReader & { close?: () => void };

type ExecutionTestStore = ExecutionManagementTestStore &
  ControlPlaneManagementStore &
  ControlPlaneEmployeeExecutionStore &
  ControlPlaneExecutionTargetStore &
  ControlPlaneAtomicVmCredentialStore &
  ControlPlaneSshCredentialEnvelopeStore &
  ControlPlaneVmLifecycleStore &
  ControlPlaneVmSelfServiceStore &
  ControlPlaneSavedVmConnectionStore;

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
export const testHostKey = {
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

export function createMemoryStore(): ExecutionManagementTestStore {
  return new InMemoryControlPlaneStore({
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin.user"],
    idFactory: createIdFactory(),
  });
}

export function createSqliteStore(): ExecutionTestStore {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-execution-store-"));
  temporaryDirectories.push(directory);
  return new SqliteControlPlaneStore({
    databasePath: join(directory, "state", "platformclaw-control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin.user"],
    idFactory: createIdFactory(),
  });
}

export async function createActivePersonalAgent(
  store: ExecutionManagementTestStore,
  accountId: string,
) {
  const { user } = await store.upsertPrincipal(principal(accountId), 1_000);
  const reserved = await store.reservePersonalAgent(user.id, 2_000);
  const binding = await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: 3_000,
  });
  return { user, binding };
}

export async function prepareVm(store: ExecutionManagementTestStore) {
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

export function cleanupExecutionStoreDirectories(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}
