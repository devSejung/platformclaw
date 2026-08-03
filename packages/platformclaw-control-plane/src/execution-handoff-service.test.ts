import { describe, expect, it, vi } from "vitest";
import type {
  AssignedVmExecutionTarget,
  ControlPlaneExecutionTargetStore,
  PersonalExecutionTarget,
} from "./execution-contracts.js";
import {
  ExecutionHandoffService,
  type ExecutionCredentialGrantIssuer,
} from "./execution-handoff-service.js";

function assignedVm(revision = 4): AssignedVmExecutionTarget {
  return {
    kind: "assigned_vm",
    agentId: "person_one",
    userId: "user-one",
    targetId: "allocation-one",
    revision,
    allocationId: "allocation-one",
    credentialRevision: 3,
    vmLabel: "Development VM",
    safeConnectLabel: "Corporate access",
    endpointHost: "safeconnect.example.test",
    endpointPort: 44_422,
    adDomain: "example.test",
    adAccount: "person.one",
    targetAddress: "192.0.2.10",
    linuxAccount: "linux-one",
    remoteHomeDir: "/users/linux-one",
    remoteWorkspaceDir: "/users/linux-one/.platformclaw/workspace",
    hostKeyAlgorithm: "ssh-ed25519",
    hostKeyPublicKey: "AAAAC3NzaC1lZDI1NTE5AAAAITest",
    hostKeyFingerprint: "SHA256:test",
  };
}

function executionStore(
  resolvePersonalExecutionTarget: () => Promise<PersonalExecutionTarget>,
): ControlPlaneExecutionTargetStore {
  return {
    resolveExecutionTarget: resolvePersonalExecutionTarget,
    resolvePersonalExecutionTarget,
    resolveAssignedVmConnectionTarget: vi.fn(),
    changePersonalExecutionTarget: vi.fn(),
  };
}

describe("ExecutionHandoffService", () => {
  it("projects a credential-free server target", async () => {
    const store = executionStore(async () => ({
      kind: "platform_server",
      agentId: "person_one",
      userId: "user-one",
      targetId: "platform-server",
      revision: 0,
    }));
    const broker = {
      address: "/run/platformclaw/broker.sock",
      issueForUser: vi.fn(),
    } satisfies ExecutionCredentialGrantIssuer;

    await expect(
      new ExecutionHandoffService(store, broker).resolveTarget("person_one"),
    ).resolves.toEqual({
      kind: "platform_server",
      agentId: "person_one",
      targetId: "platform-server",
      revision: 0,
    });
    expect(broker.issueForUser).not.toHaveBeenCalled();
  });

  it("routes a Knox room to the credential-free platform server", async () => {
    const roomTarget = {
      kind: "platform_server" as const,
      agentId: "group-room-1",
      targetId: "platform-server" as const,
      revision: 0,
    };
    const resolvePersonalExecutionTarget = vi.fn(async () => ({
      ...roomTarget,
      userId: "unused",
    }));
    const store = executionStore(resolvePersonalExecutionTarget);
    store.resolveExecutionTarget = vi.fn(async () => roomTarget);
    const broker = {
      address: "/run/platformclaw/broker.sock",
      issueForUser: vi.fn(),
    } satisfies ExecutionCredentialGrantIssuer;

    await expect(
      new ExecutionHandoffService(store, broker).resolveTarget("group-room-1"),
    ).resolves.toEqual(roomTarget);
    expect(resolvePersonalExecutionTarget).not.toHaveBeenCalled();
    expect(broker.issueForUser).not.toHaveBeenCalled();
  });

  it("binds a one-shot grant to the prepared VM allocation and revision", async () => {
    let current: PersonalExecutionTarget = assignedVm();
    let validate: (() => Promise<void>) | undefined;
    const store = executionStore(async () => current);
    const broker: ExecutionCredentialGrantIssuer = {
      address: "/run/platformclaw/runtime.sock",
      issueForUser: vi.fn((userId, callback) => {
        expect(userId).toBe("user-one");
        validate = callback;
        return { token: "grant-token", expiresAt: 30_000 };
      }),
    };
    const service = new ExecutionHandoffService(store, broker);

    await expect(
      service.issueCredentialGrant({
        agentId: "person_one",
        allocationId: "allocation-one",
        targetRevision: 4,
        credentialRevision: 3,
      }),
    ).resolves.toEqual({
      token: "grant-token",
      expiresAt: 30_000,
      brokerAddress: "/run/platformclaw/runtime.sock",
      agentId: "person_one",
      allocationId: "allocation-one",
      targetRevision: 4,
      credentialRevision: 3,
    });
    expect(validate).toBeTypeOf("function");
    await expect(validate?.()).resolves.toBeUndefined();

    current = assignedVm(5);
    await expect(validate?.()).rejects.toThrow("target changed before credential redemption");
  });

  it("rejects redemption after the credential revision changes", async () => {
    let current: PersonalExecutionTarget = assignedVm();
    let validate: (() => Promise<void>) | undefined;
    const service = new ExecutionHandoffService(
      executionStore(async () => current),
      {
        address: "/run/platformclaw/runtime.sock",
        issueForUser: (_userId, callback) => {
          validate = callback;
          return { token: "grant-token", expiresAt: 30_000 };
        },
      },
    );
    await service.issueCredentialGrant({
      agentId: "person_one",
      allocationId: "allocation-one",
      targetRevision: 4,
      credentialRevision: 3,
    });

    current = { ...assignedVm(), credentialRevision: 4 };
    await expect(validate?.()).rejects.toThrow("target changed before credential redemption");
  });

  it("does not expose the control-plane user identifier in a VM target", async () => {
    const store = executionStore(async () => assignedVm());
    const broker = {
      address: "/run/platformclaw/runtime.sock",
      issueForUser: vi.fn(),
    } satisfies ExecutionCredentialGrantIssuer;

    const target = await new ExecutionHandoffService(store, broker).resolveTarget("person_one");

    expect(target).toMatchObject({
      kind: "assigned_vm",
      allocationId: "allocation-one",
      remoteHomeDir: "/users/linux-one",
    });
    expect(target).not.toHaveProperty("userId");
  });

  it("uses path sentinels only for a connection snapshot that still needs probing", async () => {
    const {
      credentialRevision: _credentialRevision,
      remoteHomeDir: _home,
      remoteWorkspaceDir: _workspace,
      ...target
    } = assignedVm();
    const store = executionStore(async () => assignedVm());
    vi.spyOn(store, "resolveAssignedVmConnectionTarget").mockResolvedValue({
      ...target,
      allocationStatus: "connection_required",
    });
    const broker = {
      address: "/run/platformclaw/runtime.sock",
      issueForUser: vi.fn(),
    } satisfies ExecutionCredentialGrantIssuer;

    await expect(
      new ExecutionHandoffService(store, broker).resolveConnectionTarget("person_one"),
    ).resolves.toMatchObject({
      credentialRevision: 0,
      remoteHomeDir: "/",
      remoteWorkspaceDir: "/",
    });
  });

  it("does not issue a VM credential for the basic workspace", async () => {
    const store = executionStore(async () => ({
      kind: "platform_server",
      agentId: "person_one",
      userId: "user-one",
      targetId: "platform-server",
      revision: 2,
    }));
    const broker = {
      address: "/run/platformclaw/runtime.sock",
      issueForUser: vi.fn(),
    } satisfies ExecutionCredentialGrantIssuer;

    await expect(
      new ExecutionHandoffService(store, broker).issueCredentialGrant({
        agentId: "person_one",
        allocationId: "allocation-one",
        targetRevision: 2,
        credentialRevision: 3,
      }),
    ).rejects.toThrow("target changed before credential redemption");
    expect(broker.issueForUser).not.toHaveBeenCalled();
  });
});
