import type { CreateSandboxBackendParams, SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";
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
            remoteWorkspaceDir: "/srv/person-two",
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
    expect(first).toMatchObject({
      id: PLATFORMCLAW_EXECUTION_BACKEND_ID,
      runtimeId: "server-person_one-3",
    });
    expect(second).toMatchObject({
      id: PLATFORMCLAW_EXECUTION_BACKEND_ID,
      runtimeId: "vm-person_two-7",
    });
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
      remoteWorkspaceDir: "/srv/person-one",
    }));
    vi.mocked(dependencies.createAssignedVmHandle).mockRejectedValueOnce(
      new Error("VM connection unavailable"),
    );

    await expect(
      createPlatformClawExecutionBackendFactory(dependencies)(createParams("person_one")),
    ).rejects.toThrow("VM connection unavailable");
    expect(dependencies.createPlatformServerHandle).not.toHaveBeenCalled();
  });
});
