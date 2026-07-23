import { describe, expect, it, vi } from "vitest";
import type {
  AssignedVmExecutionTarget,
  ControlPlaneExecutionRuntimeStore,
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
    endpointHost: "safeconnect.example.test",
    endpointPort: 44_422,
    adDomain: "example.test",
    adAccount: "person.one",
    targetAddress: "192.0.2.10",
    linuxAccount: "linux-one",
    remoteWorkspaceDir: "/users/linux-one/.platformclaw/workspace",
    hostKeyAlgorithm: "ssh-ed25519",
    hostKeyPublicKey: "AAAAC3NzaC1lZDI1NTE5AAAAITest",
    hostKeyFingerprint: "SHA256:test",
  };
}

describe("ExecutionHandoffService", () => {
  it("projects a credential-free server target", async () => {
    const store: ControlPlaneExecutionRuntimeStore = {
      resolvePersonalExecutionTarget: async () => ({
        kind: "platform_server",
        agentId: "person_one",
        userId: "user-one",
        targetId: "platform-server",
        revision: 0,
      }),
    };
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

  it("binds a one-shot grant to the prepared VM allocation and revision", async () => {
    let current: PersonalExecutionTarget = assignedVm();
    let validate: (() => Promise<void>) | undefined;
    const store: ControlPlaneExecutionRuntimeStore = {
      resolvePersonalExecutionTarget: async () => current,
    };
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
      }),
    ).resolves.toEqual({
      token: "grant-token",
      expiresAt: 30_000,
      brokerAddress: "/run/platformclaw/runtime.sock",
      agentId: "person_one",
      allocationId: "allocation-one",
      targetRevision: 4,
    });
    expect(validate).toBeTypeOf("function");
    await expect(validate?.()).resolves.toBeUndefined();

    current = assignedVm(5);
    await expect(validate?.()).rejects.toThrow("target changed before credential redemption");
  });

  it("does not expose the control-plane user identifier in a VM target", async () => {
    const store: ControlPlaneExecutionRuntimeStore = {
      resolvePersonalExecutionTarget: async () => assignedVm(),
    };
    const broker = {
      address: "/run/platformclaw/runtime.sock",
      issueForUser: vi.fn(),
    } satisfies ExecutionCredentialGrantIssuer;

    const target = await new ExecutionHandoffService(store, broker).resolveTarget("person_one");

    expect(target).toMatchObject({ kind: "assigned_vm", allocationId: "allocation-one" });
    expect(target).not.toHaveProperty("userId");
  });

  it("does not issue a VM credential for the basic workspace", async () => {
    const store: ControlPlaneExecutionRuntimeStore = {
      resolvePersonalExecutionTarget: async () => ({
        kind: "platform_server",
        agentId: "person_one",
        userId: "user-one",
        targetId: "platform-server",
        revision: 2,
      }),
    };
    const broker = {
      address: "/run/platformclaw/runtime.sock",
      issueForUser: vi.fn(),
    } satisfies ExecutionCredentialGrantIssuer;

    await expect(
      new ExecutionHandoffService(store, broker).issueCredentialGrant({
        agentId: "person_one",
        allocationId: "allocation-one",
        targetRevision: 2,
      }),
    ).rejects.toThrow("target changed before credential redemption");
    expect(broker.issueForUser).not.toHaveBeenCalled();
  });
});
