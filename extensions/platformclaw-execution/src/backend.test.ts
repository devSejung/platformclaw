import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SkillWorkshopTargetAccess,
} from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it, vi } from "vitest";
import {
  createPlatformClawExecutionBackendFactory,
  PLATFORMCLAW_EXECUTION_BACKEND_ID,
  type PlatformClawExecutionDependencies,
  type PlatformClawExecutionTargetSnapshot,
} from "./backend.js";

function createParams(
  agentId?: string,
  scopeKey = "opaque|scope::value",
): CreateSandboxBackendParams {
  return {
    ...(agentId ? { agentId } : {}),
    sessionKey: `agent:${agentId ?? "unknown"}:main`,
    scopeKey,
    workspaceDir: `/workspace/${agentId ?? "unknown"}`,
    agentWorkspaceDir: `/agents/${agentId ?? "unknown"}`,
    cfg: {} as CreateSandboxBackendParams["cfg"],
  };
}

function createHandle(runtimeId: string): SandboxBackendHandle {
  return {
    id: "selected-handle",
    runtimeId,
    runtimeLabel: runtimeId,
    workdir: `/${runtimeId}`,
    buildExecSpec: async () => ({
      argv: [runtimeId],
      env: {},
      stdinMode: "pipe-closed",
    }),
    runShellCommand: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }),
  };
}

function createDependencies(
  resolveTarget: PlatformClawExecutionDependencies["resolveTarget"],
): PlatformClawExecutionDependencies {
  return {
    resolveTarget: vi.fn(resolveTarget),
    createPlatformServerHandle: vi.fn(async ({ target }) =>
      createHandle(`server-${target.agentId}-${target.revision}`),
    ),
    createAssignedVmHandle: vi.fn(async ({ target }) =>
      createHandle(`vm-${target.agentId}-${target.revision}`),
    ),
    listTargetSkills: vi.fn(async () => undefined),
    createSkillWorkshopTarget: vi.fn(async () => undefined),
  };
}

describe("PlatformClaw execution backend", () => {
  it("isolates users and selects targets without parsing scope keys", async () => {
    const resolveTarget = vi.fn(async ({ agentId }: { agentId: string }) =>
      agentId === "person_one"
        ? ({
            kind: "platform_server",
            agentId,
            revision: 3,
            targetId: "server-default",
          } satisfies PlatformClawExecutionTargetSnapshot)
        : ({
            kind: "assigned_vm",
            agentId,
            revision: 7,
            targetId: "vm-allocation",
            allocationId: "allocation-two",
            vmLabel: "Person Two VM",
            safeConnectLabel: "Corporate access",
            remoteHomeDir: "/srv/person-two",
            remoteWorkspaceDir: "/srv/person-two",
            endpointHost: "safeconnect.example",
            endpointPort: 44422,
            adDomain: "example",
            adAccount: "person.two",
            targetAddress: "192.0.2.2",
            linuxAccount: "person.two",
            hostKeyAlgorithm: "ssh-ed25519",
            hostKeyPublicKey: "AAAA-test",
            hostKeyFingerprint: "SHA256:test",
          } satisfies PlatformClawExecutionTargetSnapshot),
    );
    const dependencies = createDependencies(resolveTarget);
    const factory = createPlatformClawExecutionBackendFactory(dependencies);
    const firstParams = createParams("person_one", "agent:person_two:misleading|scope");
    const secondParams = createParams("person_two", "group-room-123::opaque");

    const [first, second] = await Promise.all([factory(firstParams), factory(secondParams)]);

    expect(resolveTarget.mock.calls).toEqual([
      [{ agentId: "person_one" }],
      [{ agentId: "person_two" }],
    ]);
    expect(dependencies.createPlatformServerHandle).toHaveBeenCalledWith(
      expect.objectContaining({ createParams: firstParams }),
    );
    expect(dependencies.createAssignedVmHandle).toHaveBeenCalledWith(
      expect.objectContaining({ createParams: secondParams }),
    );
    expect(dependencies.listTargetSkills).toHaveBeenCalledWith(
      expect.objectContaining({ refresh: true }),
    );
    expect(first).toMatchObject({
      id: PLATFORMCLAW_EXECUTION_BACKEND_ID,
      runtimeId: "server-person_one-3",
      runtimePromptContext: expect.stringContaining('"workLocation": "Basic workspace"'),
    });
    expect(first.runtimePromptContext).toContain('"activeWorkspace": "/server-person_one-3"');
    expect(second).toMatchObject({
      id: PLATFORMCLAW_EXECUTION_BACKEND_ID,
      runtimeId: "vm-person_two-7",
      runtimePromptContext: expect.stringContaining('"workLocation": "My development VM"'),
    });
    expect(second.runtimePromptContext).toContain('"targetLabel": "Person Two VM"');
    expect(second.runtimePromptContext).toContain('"safeHostLabel": "Corporate access"');
    expect(second.runtimePromptContext).toContain('"linuxAccount": "person.two"');
    expect(second.runtimePromptContext).toContain('"linuxHome": "/srv/person-two"');
    expect(second.runtimePromptContext).toContain("full Linux home");
    expect(second.runtimePromptContext).toContain('"activeWorkspace": "/vm-person_two-7"');
    expect(second.runtimePromptContext).not.toContain("safeconnect.example");
    expect(second.runtimePromptContext).not.toContain("192.0.2.2");
    expect(second.runtimePromptContext).not.toContain("person.two@external");
  });

  it("pins a copied target snapshot for one backend handle", async () => {
    const mutableTarget: PlatformClawExecutionTargetSnapshot = {
      kind: "platform_server",
      agentId: "person_one",
      revision: 1,
      targetId: "server-default",
    };
    const dependencies = createDependencies(async () => mutableTarget);
    const createServerHandle = vi.mocked(dependencies.createPlatformServerHandle);
    createServerHandle.mockImplementationOnce(async ({ target }) => {
      mutableTarget.revision = 99;
      mutableTarget.targetId = "changed-after-resolution";
      expect(target).toEqual({
        kind: "platform_server",
        agentId: "person_one",
        revision: 1,
        targetId: "server-default",
      });
      expect(Object.isFrozen(target)).toBe(true);
      return createHandle(`server-${target.revision}`);
    });

    const handle = await createPlatformClawExecutionBackendFactory(dependencies)(
      createParams("person_one"),
    );

    expect(handle.runtimeId).toBe("server-1");
    expect(dependencies.resolveTarget).toHaveBeenCalledOnce();
  });

  it("exposes local Workshop on Basic and the pinned VM Workshop target on a VM", async () => {
    const vmTarget: PlatformClawExecutionTargetSnapshot = {
      kind: "assigned_vm",
      agentId: "person_one",
      revision: 4,
      targetId: "vm-one",
      allocationId: "allocation-one",
      vmLabel: "Development VM",
      safeConnectLabel: "Corporate access",
      remoteHomeDir: "/srv/person-one",
      remoteWorkspaceDir: "/srv/person-one/.platformclaw/workspace",
      endpointHost: "safeconnect.example",
      endpointPort: 44422,
      adDomain: "example",
      adAccount: "person.one",
      targetAddress: "192.0.2.1",
      linuxAccount: "person.one",
      hostKeyAlgorithm: "ssh-ed25519",
      hostKeyPublicKey: "AAAA-test",
      hostKeyFingerprint: "SHA256:test",
    };
    const dependencies = createDependencies(async () => vmTarget);
    const catalog = { revision: "vm-one:4", files: [] };
    const workshopTarget = {
      backendId: PLATFORMCLAW_EXECUTION_BACKEND_ID,
      targetId: "allocation-one",
    } as SkillWorkshopTargetAccess;
    vi.mocked(dependencies.listTargetSkills).mockResolvedValueOnce(catalog);
    vi.mocked(dependencies.createSkillWorkshopTarget).mockResolvedValueOnce(workshopTarget);

    const vmHandle = await createPlatformClawExecutionBackendFactory(dependencies)(
      createParams("person_one"),
    );
    expect(dependencies.createSkillWorkshopTarget).toHaveBeenCalledWith({
      target: expect.objectContaining({ allocationId: "allocation-one" }),
      catalog,
    });
    expect(vmHandle.skillWorkshopTarget).toBe(workshopTarget);

    const basicDependencies = createDependencies(async () => ({
      kind: "platform_server",
      agentId: "person_one",
      revision: 5,
      targetId: "server-default",
    }));
    const basicHandle = await createPlatformClawExecutionBackendFactory(basicDependencies)(
      createParams("person_one"),
    );
    expect(basicHandle.skillWorkshopTarget).toEqual({ kind: "workspace" });
    expect(basicDependencies.createSkillWorkshopTarget).not.toHaveBeenCalled();
  });

  it("fails closed without a prepared owner or with a mismatched owner", async () => {
    const missingOwnerDependencies = createDependencies(async () => ({
      kind: "platform_server",
      agentId: "person_one",
      revision: 1,
      targetId: "server-default",
    }));
    await expect(
      createPlatformClawExecutionBackendFactory(missingOwnerDependencies)(createParams()),
    ).rejects.toThrow("requires a prepared agent owner");
    expect(missingOwnerDependencies.resolveTarget).not.toHaveBeenCalled();

    const wrongOwnerDependencies = createDependencies(async () => ({
      kind: "platform_server",
      agentId: "person_two",
      revision: 1,
      targetId: "server-default",
    }));
    await expect(
      createPlatformClawExecutionBackendFactory(wrongOwnerDependencies)(createParams("person_one")),
    ).rejects.toThrow("owner does not match");
    expect(wrongOwnerDependencies.createPlatformServerHandle).not.toHaveBeenCalled();
    expect(wrongOwnerDependencies.createAssignedVmHandle).not.toHaveBeenCalled();
  });

  it("does not fall back when the selected VM handle fails", async () => {
    const dependencies = createDependencies(async () => ({
      kind: "assigned_vm",
      agentId: "person_one",
      revision: 4,
      targetId: "vm-one",
      allocationId: "allocation-one",
      vmLabel: "Development VM",
      safeConnectLabel: "Corporate access",
      remoteHomeDir: "/srv/person-one",
      remoteWorkspaceDir: "/srv/person-one",
      endpointHost: "safeconnect.example",
      endpointPort: 44422,
      adDomain: "example",
      adAccount: "person.one",
      targetAddress: "192.0.2.1",
      linuxAccount: "person.one",
      hostKeyAlgorithm: "ssh-ed25519",
      hostKeyPublicKey: "AAAA-test",
      hostKeyFingerprint: "SHA256:test",
    }));
    vi.mocked(dependencies.createAssignedVmHandle).mockRejectedValueOnce(
      new Error("VM connection unavailable"),
    );

    await expect(
      createPlatformClawExecutionBackendFactory(dependencies)(createParams("person_one")),
    ).rejects.toThrow("VM connection unavailable");
    expect(dependencies.createPlatformServerHandle).not.toHaveBeenCalled();
  });

  it("does not create a backend handle when target skill discovery fails", async () => {
    const dependencies = createDependencies(async () => ({
      kind: "assigned_vm",
      agentId: "person_one",
      revision: 4,
      targetId: "vm-one",
      allocationId: "allocation-one",
      vmLabel: "Development VM",
      safeConnectLabel: "Corporate access",
      remoteHomeDir: "/srv/person-one",
      remoteWorkspaceDir: "/srv/person-one",
      endpointHost: "safeconnect.example",
      endpointPort: 44422,
      adDomain: "example",
      adAccount: "person.one",
      targetAddress: "192.0.2.1",
      linuxAccount: "person.one",
      hostKeyAlgorithm: "ssh-ed25519",
      hostKeyPublicKey: "AAAA-test",
      hostKeyFingerprint: "SHA256:test",
    }));
    vi.mocked(dependencies.listTargetSkills).mockRejectedValueOnce(
      new Error("VM skill catalog is invalid"),
    );

    await expect(
      createPlatformClawExecutionBackendFactory(dependencies)(createParams("person_one")),
    ).rejects.toThrow("catalog is invalid");
    expect(dependencies.createAssignedVmHandle).not.toHaveBeenCalled();
  });
});
