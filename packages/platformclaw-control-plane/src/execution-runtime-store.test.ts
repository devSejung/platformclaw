import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const temporaryDirectories: string[] = [];
const cleanupCallbacks: Array<() => void> = [];

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

const hostKeyBlob = Buffer.concat([
  sshString(Buffer.from("ssh-ed25519")),
  sshString(Buffer.alloc(32, 9)),
]);
const hostKey = {
  algorithm: "ssh-ed25519",
  publicKey: hostKeyBlob.toString("base64"),
  fingerprint: `SHA256:${createHash("sha256")
    .update(hostKeyBlob)
    .digest("base64")
    .replace(/=+$/u, "")}`,
};

afterEach(() => {
  for (const cleanup of cleanupCallbacks.splice(0).toReversed()) {
    cleanup();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite execution runtime target", () => {
  it("resolves the default server target and one ready pinned VM target", async () => {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-runtime-target-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "control.sqlite");
    const store = new SqliteControlPlaneStore({
      databasePath,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      initialAdminAccountIds: ["admin.user"],
    });
    cleanupCallbacks.push(() => store.close());
    const { user } = await store.upsertPrincipal(
      {
        provider: "ldap",
        subject: "admin.user",
        accountId: "admin.user",
        employeeId: "1001",
      },
      1,
    );
    const reserved = await store.reservePersonalAgent(user.id, 2);
    const binding = await store.transitionAgent({
      bindingId: reserved.binding.id,
      state: "active",
      changedAt: 3,
    });

    await expect(store.resolvePersonalExecutionTarget(binding.agentId)).resolves.toEqual({
      kind: "platform_server",
      agentId: binding.agentId,
      userId: user.id,
      targetId: "platform-server",
      revision: 0,
    });

    const endpoint = await store.createSafeConnectEndpoint({
      actorUserId: user.id,
      label: "SafeConnect",
      host: "safeconnect.example.test",
      port: 44_422,
      adDomain: "example.test",
      createdAt: 4,
    });
    await store.approveSafeConnectHostKey({
      actorUserId: user.id,
      endpointId: endpoint.id,
      ...hostKey,
      approvedAt: 5,
    });
    const host = await store.createVmHost({
      actorUserId: user.id,
      endpointId: endpoint.id,
      label: "Development VM",
      targetAddress: "192.0.2.10",
      createdAt: 6,
    });
    const allocation = await store.assignVmToPersonalAgent({
      actorUserId: user.id,
      agentId: binding.agentId,
      vmHostId: host.id,
      linuxAccount: "linux-user",
      assignedAt: 7,
    });
    const database = new DatabaseSync(databasePath);
    cleanupCallbacks.push(() => database.close());
    database.exec("PRAGMA foreign_keys = ON");
    database
      .prepare(
        `UPDATE vm_allocations
         SET status = 'ready', remote_home_dir = ?, remote_workspace_dir = ?,
             last_connection_succeeded_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run("/users/linux-user", "/users/linux-user/.platformclaw/workspace", 8, 8, allocation.id);
    database
      .prepare(
        `UPDATE personal_execution_profiles
         SET active_target = 'assigned_vm', active_allocation_id = ?, target_revision = 1, updated_at = ?
         WHERE agent_binding_id = ?`,
      )
      .run(allocation.id, 9, binding.id);

    await expect(store.resolvePersonalExecutionTarget(binding.agentId)).resolves.toMatchObject({
      kind: "assigned_vm",
      agentId: binding.agentId,
      userId: user.id,
      targetId: allocation.id,
      revision: 1,
      allocationId: allocation.id,
      endpointHost: "safeconnect.example.test",
      endpointPort: 44_422,
      adDomain: "example.test",
      adAccount: "admin.user",
      targetAddress: "192.0.2.10",
      linuxAccount: "linux-user",
      remoteWorkspaceDir: "/users/linux-user/.platformclaw/workspace",
      hostKeyAlgorithm: "ssh-ed25519",
      hostKeyFingerprint: hostKey.fingerprint,
    });
  });
});
