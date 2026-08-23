import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SkillWorkshopTargetAccess,
} from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it, vi } from "vitest";
import {
  createPlatformClawExecutionBackendFactory,
  createPlatformClawExecutionSkillInstallProvider,
  createPlatformClawExecutionSkillProvider,
  createPlatformClawExecutionTerminalProvider,
  PLATFORMCLAW_EXECUTION_BACKEND_ID,
  type PlatformClawExecutionDependencies,
  type PlatformClawExecutionTargetSnapshot,
} from "./backend.js";
import { PlatformClawTargetMutationCoordinator } from "./target-mutation-coordinator.js";

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
    materializeSkills: vi.fn(async () => ({
      catalog: { revision: "gateway:test", files: [] },
      mounts: [
        {
          hostPath: `/gateway/${agentId ?? "unknown"}/managed-skills`,
          containerPath: "/opt/platformclaw/skills",
        },
      ],
    })),
    cfg: {} as CreateSandboxBackendParams["cfg"],
  };
}

function createHandle(runtimeId: string): SandboxBackendHandle {
  return {
    id: "selected-handle",
    runtimeId,
    runtimeLabel: runtimeId,
    workdir: `/${runtimeId}`,
    env: { SHARED_BUILD_FLAG: "server-default" },
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
    listTargetSkills: vi.fn(async ({ target }) =>
      target.kind === "assigned_vm"
        ? { revision: `${target.targetId}:${target.revision}`, files: [] }
        : undefined,
    ),
    createSkillWorkshopTarget: vi.fn(async () => undefined),
    createSkillInstallTarget: vi.fn(async () => undefined),
    createTerminalProcess: vi.fn(async () => ({
      file: "ssh",
      args: ["vm"],
      cwd: "/gateway",
      dispose: vi.fn(async () => undefined),
    })),
    resolveExecCredentials: vi.fn(async () => ({})),
  };
}

describe("PlatformClaw execution backend", () => {
  it("passes Basic credentials through Docker client env without argv values", async () => {
    const dependencies = createDependencies(async ({ agentId }) => ({
      kind: "platform_server",
      agentId,
      revision: 1,
      targetId: "basic",
    }));
    dependencies.resolveExecCredentials = vi.fn(async () => ({ API_TOKEN: "private-value" }));
    dependencies.createPlatformServerHandle = vi.fn(async () =>
      ({
        ...createHandle("basic"),
        buildExecSpec: async ({ env }) => ({
          argv: ["docker", "exec", "-e", `API_TOKEN=${env.API_TOKEN}`, "basic", "sh"],
          env: {},
          stdinMode: "pipe-closed",
        }),
      }) satisfies SandboxBackendHandle,
    );
    const handle = await createPlatformClawExecutionBackendFactory(dependencies)(
      createParams("person_one"),
    );

    const spec = await handle.buildExecSpec({ command: "env", env: {}, usePty: false });

    expect(spec.argv).toEqual(["docker", "exec", "-e", "API_TOKEN", "basic", "sh"]);
    expect(spec.env.API_TOKEN).toBe("private-value");
    expect(spec.argv.join(" ")).not.toContain("private-value");
  });

  it("frames VM credentials on stdin and disables remote TTY echo", async () => {
    const dependencies = createDependencies(async ({ agentId }) => ({
      kind: "assigned_vm",
      agentId,
      revision: 1,
      targetId: "vm",
      allocationId: "allocation",
      credentialRevision: 1,
      vmLabel: "VM",
      safeConnectLabel: "safe",
      remoteHomeDir: "/home/user",
      remoteWorkspaceDir: "/home/user/work",
      endpointHost: "vm.example",
      endpointPort: 22,
      adDomain: "example",
      adAccount: "person",
      targetAddress: "vm.example",
      linuxAccount: "user",
      hostKeyAlgorithm: "ssh-ed25519",
      hostKeyPublicKey: "key",
      hostKeyFingerprint: "fingerprint",
    }));
    dependencies.resolveExecCredentials = vi.fn(async () => ({ API_TOKEN: "private-value" }));
    dependencies.createAssignedVmHandle = vi.fn(async () =>
      ({
        ...createHandle("vm"),
        buildExecSpec: async () => ({
          argv: [
            "ssh",
            "-F",
            "config",
            "-tt",
            "-o",
            "RequestTTY=force",
            "-o",
            "SetEnv=TERM=xterm-256color",
            "host",
            "env LANG=C sh",
          ],
          env: {},
          stdinMode: "pipe-open",
        }),
      }) satisfies SandboxBackendHandle,
    );
    const handle = await createPlatformClawExecutionBackendFactory(dependencies)(
      createParams("person_one"),
    );

    const spec = await handle.buildExecSpec({ command: "env", env: {}, usePty: true });

    expect(spec.argv).toContain("-T");
    expect(spec.argv).not.toContain("-tt");
    expect(spec.argv.join(" ")).not.toContain("private-value");
    expect(spec.stdinPrefix).toBe("API_TOKEN cHJpdmF0ZS12YWx1ZQ==\n.\n");
  });

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
            credentialRevision: 3,
            vmLabel: "Person Two VM",
            safeConnectLabel: "Corporate access",
            remoteHomeDir: "/srv/person-two",
            remoteWorkspaceDir: "/srv/person-two/.platformclaw/workspace",
            endpointHost: "safeconnect.example",
            endpointPort: 44422,
            adDomain: "example",
            adAccount: "person.two",
            targetAddress: "192.0.2.2",
            linuxAccount: "person.two",
            hostKeyAlgorithm: "ssh-ed25519",
            hostKeyPublicKey: "AAAA-test",
            hostKeyFingerprint: "SHA256:test",
            executionEnvironment: {
              pathPrepend: ["/opt/clang/bin", "/opt/gcc/bin"],
              variables: {
                CLANG11_PATH: "/opt/clang/bin/",
                SHARED_BUILD_FLAG: "vm-override",
              },
            },
          } satisfies PlatformClawExecutionTargetSnapshot),
    );
    const dependencies = createDependencies(resolveTarget);
    const logTiming = vi.fn();
    const factory = createPlatformClawExecutionBackendFactory(dependencies, { logTiming });
    const firstParams = createParams("person_one", "agent:person_two:misleading|scope");
    const secondParams = createParams("person_two", "group-room-123::opaque");

    const [first, second] = await Promise.all([factory(firstParams), factory(secondParams)]);

    expect(resolveTarget.mock.calls).toEqual([
      [{ agentId: "person_one" }],
      [{ agentId: "person_two" }],
    ]);
    expect(dependencies.createPlatformServerHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        createParams: expect.objectContaining({
          readOnlySkillMounts: [
            expect.objectContaining({ containerPath: "/opt/platformclaw/skills" }),
          ],
          requireCurrentConfig: true,
        }),
      }),
    );
    expect(dependencies.createAssignedVmHandle).toHaveBeenCalledWith(
      expect.objectContaining({ createParams: secondParams }),
    );
    expect(dependencies.listTargetSkills).toHaveBeenCalledWith(
      expect.objectContaining({ refresh: false }),
    );
    expect(firstParams.materializeSkills).toHaveBeenCalledOnce();
    expect(firstParams.materializeSkills).toHaveBeenCalledWith({
      sourceMounts: [
        expect.objectContaining({
          source: "openclaw-managed",
          containerPath: "/opt/platformclaw/skills",
        }),
        expect.objectContaining({
          source: "openclaw-bundled",
          containerPath: "/opt/platformclaw/bundle",
        }),
      ],
    });
    expect(secondParams.materializeSkills).not.toHaveBeenCalled();
    expect(first).toMatchObject({
      id: PLATFORMCLAW_EXECUTION_BACKEND_ID,
      runtimeId: "server-person_one-3",
      runtimePromptContext: expect.stringContaining('"workLocation": "Basic workspace"'),
      skillCatalog: { revision: "gateway:test", files: [] },
    });
    expect(first.runtimePromptContext).toContain('"activeWorkspace": "/server-person_one-3"');
    expect(first.capabilities?.separateAgentWorkspace).toBeUndefined();
    expect(second).toMatchObject({
      id: PLATFORMCLAW_EXECUTION_BACKEND_ID,
      runtimeId: "vm-person_two-7",
      runtimePromptContext: expect.stringContaining('"workLocation": "My development VM"'),
    });
    expect(second.runtimePromptContext).toContain('"targetLabel": "Person Two VM"');
    expect(second.runtimePromptContext).toContain('"safeHostLabel": "Corporate access"');
    expect(second.runtimePromptContext).toContain('"linuxAccount": "person.two"');
    expect(second.runtimePromptContext).toContain('"linuxHome": "/srv/person-two"');
    expect(second.runtimePromptContext).toContain(
      "linuxHome and activeWorkspace are different roots",
    );
    expect(second.runtimePromptContext).toContain("HOME and ~ mean linuxHome");
    expect(second.runtimePromptContext).toContain(
      "the default working directory and relative paths mean activeWorkspace",
    );
    expect(second.runtimePromptContext).toContain(
      "Never prefix activeWorkspace to paths beginning with ~ or /",
    );
    expect(second.runtimePromptContext).toContain(
      '"activeWorkspace": "/srv/person-two/.platformclaw/workspace"',
    );
    expect(second.runtimePromptContext).not.toContain('"activeWorkspace": "/vm-person_two-7"');
    expect(second.runtimePromptContext).not.toContain("safeconnect.example");
    expect(second.runtimePromptContext).not.toContain("192.0.2.2");
    expect(second.runtimePromptContext).not.toContain("person.two@external");
    expect(second.capabilities?.separateAgentWorkspace).toBe(true);
    expect(first.env).toEqual({ SHARED_BUILD_FLAG: "server-default" });
    expect(second.env).toEqual({
      PATH: "/opt/clang/bin:/opt/gcc/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      CLANG11_PATH: "/opt/clang/bin/",
      SHARED_BUILD_FLAG: "vm-override",
      HOME: "/srv/person-two",
    });
    const timingLines = logTiming.mock.calls.map(([message]) => String(message));
    expect(timingLines).toHaveLength(2);
    expect(timingLines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("targetKind=platform_server"),
        expect.stringContaining("targetKind=assigned_vm"),
      ]),
    );
    expect(timingLines.every((line) => line.includes("totalMs="))).toBe(true);
    expect(timingLines.join("\n")).not.toContain("person_two");
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
      credentialRevision: 3,
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
    expect(vmHandle.env).toEqual({
      SHARED_BUILD_FLAG: "server-default",
      HOME: "/srv/person-one",
    });

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
      credentialRevision: 3,
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

  it("materializes Basic workspace skills before creating the Docker handle", async () => {
    const dependencies = createDependencies(async () => ({
      kind: "platform_server",
      agentId: "person_one",
      revision: 1,
      targetId: "server-default",
    }));
    const params = createParams("person_one");

    await createPlatformClawExecutionBackendFactory(dependencies)(params);

    expect(params.materializeSkills).toHaveBeenCalledOnce();
    expect(vi.mocked(params.materializeSkills!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dependencies.createPlatformServerHandle).mock.invocationCallOrder[0]!,
    );
  });

  it("does not create a backend handle when target skill discovery fails", async () => {
    const dependencies = createDependencies(async () => ({
      kind: "assigned_vm",
      agentId: "person_one",
      revision: 4,
      targetId: "vm-one",
      allocationId: "allocation-one",
      credentialRevision: 3,
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

  it("pins the VM revision before resolving a remote skill installer", async () => {
    const dependencies = createDependencies(async () => ({
      kind: "assigned_vm",
      agentId: "person_one",
      revision: 4,
      targetId: "vm-one",
      allocationId: "allocation-one",
      credentialRevision: 3,
      vmLabel: "Development VM",
      safeConnectLabel: "Corporate access",
      remoteHomeDir: "/srv/person-one",
      remoteWorkspaceDir: "/srv/person-one/workspace",
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
    const provider = createPlatformClawExecutionSkillInstallProvider(
      dependencies,
      new PlatformClawTargetMutationCoordinator(),
    );

    await expect(
      provider({
        agentId: "person_one",
        config: {} as never,
        workspaceDir: "/basic",
        expectedTargetRevision: 3,
      }),
    ).rejects.toThrow("target changed");
    expect(dependencies.createSkillInstallTarget).not.toHaveBeenCalled();
  });

  it("revalidates the Basic target after acquiring the shared mutation guard", async () => {
    let target: PlatformClawExecutionTargetSnapshot = {
      kind: "platform_server",
      agentId: "person_one",
      revision: 1,
      targetId: "platform-server",
    };
    const dependencies = createDependencies(async () => target);
    const mutations = new PlatformClawTargetMutationCoordinator();
    const provider = createPlatformClawExecutionSkillInstallProvider(dependencies, mutations);
    const installTarget = await provider({
      agentId: "person_one",
      config: {} as never,
      workspaceDir: "/basic",
      expectedTargetRevision: 1,
    });
    target = {
      kind: "assigned_vm",
      agentId: "person_one",
      revision: 2,
      targetId: "vm-one",
      allocationId: "allocation-one",
      credentialRevision: 3,
      vmLabel: "Development VM",
      safeConnectLabel: "Corporate access",
      remoteHomeDir: "/srv/person-one",
      remoteWorkspaceDir: "/srv/person-one/workspace",
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
    const operation = vi.fn(async () => undefined);

    await expect(installTarget.runExclusive(operation)).rejects.toThrow("target changed");
    expect(operation).not.toHaveBeenCalled();
    expect(mutations.isHeld("person_one")).toBe(false);
  });

  it("holds the shared mutation guard for the complete install operation", async () => {
    const dependencies = createDependencies(async () => ({
      kind: "platform_server",
      agentId: "person_one",
      revision: 1,
      targetId: "platform-server",
    }));
    const mutations = new PlatformClawTargetMutationCoordinator();
    const provider = createPlatformClawExecutionSkillInstallProvider(dependencies, mutations);
    const installTarget = await provider({
      agentId: "person_one",
      config: {} as never,
      workspaceDir: "/basic",
      expectedTargetRevision: 1,
    });

    await installTarget.runExclusive(async () => {
      expect(mutations.tryAcquire("person_one", "target-change")).toBeNull();
    });

    const release = mutations.tryAcquire("person_one", "target-change");
    expect(release).not.toBeNull();
    release?.();
  });

  it("pins an explicit install target independently of the active execution target", async () => {
    const resolveTarget = vi.fn(
      async ({ agentId, target }: { agentId: string; target?: string }) => {
        expect(target).toBe("platform_server");
        return {
          kind: "platform_server" as const,
          agentId,
          revision: 9,
          targetId: "platform-server" as const,
        };
      },
    );
    const dependencies = createDependencies(resolveTarget);
    const provider = createPlatformClawExecutionSkillInstallProvider(
      dependencies,
      new PlatformClawTargetMutationCoordinator(),
    );
    const target = await provider({
      agentId: "person_one",
      config: {} as never,
      workspaceDir: "/basic",
      backendTarget: "platform_server",
      expectedTargetRevision: 9,
    });
    await target.runExclusive(async () => undefined);
    expect(resolveTarget).toHaveBeenCalledTimes(2);
    expect(target.kind).toBe("workspace");
  });

  it("lists an explicit target independently of the active execution target", async () => {
    const resolveTarget = vi.fn(
      async ({ agentId, target }: { agentId: string; target?: string }) => ({
        kind: target === "assigned_vm" ? ("assigned_vm" as const) : ("platform_server" as const),
        agentId,
        revision: 9,
        targetId: target === "assigned_vm" ? "vm-one" : "platform-server",
        ...(target === "assigned_vm"
          ? {
              allocationId: "allocation-one",
              credentialRevision: 3,
              vmLabel: "VM",
              safeConnectLabel: "SafeConnect",
              remoteHomeDir: "/home/person_one",
              remoteWorkspaceDir: "/home/person_one/workspace",
              endpointHost: "vm.example",
              endpointPort: 22,
              adDomain: "example",
              adAccount: "person.one",
              targetAddress: "192.0.2.1",
              linuxAccount: "person_one",
              hostKeyAlgorithm: "ssh-ed25519",
              hostKeyPublicKey: "AAAA-test",
              hostKeyFingerprint: "SHA256:test",
            }
          : {}),
      }),
    );
    const dependencies = createDependencies(resolveTarget as never);
    const provider = createPlatformClawExecutionSkillProvider(dependencies);

    await provider({
      agentId: "person_one",
      config: {} as never,
      workspaceDir: "/basic",
      refresh: true,
      backendTarget: "assigned_vm",
    });

    expect(resolveTarget).toHaveBeenCalledWith({
      agentId: "person_one",
      target: "assigned_vm",
    });
    expect(dependencies.listTargetSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        refresh: true,
        target: expect.objectContaining({ kind: "assigned_vm" }),
      }),
    );
  });

  it("opens a login terminal only for one revision-pinned assigned VM", async () => {
    const target = {
      kind: "assigned_vm" as const,
      agentId: "person_one",
      revision: 9,
      targetId: "vm-one",
      allocationId: "allocation-one",
      credentialRevision: 3,
      vmLabel: "Development VM",
      safeConnectLabel: "SafeConnect",
      remoteHomeDir: "/home/person_one",
      remoteWorkspaceDir: "/home/person_one/workspace",
      endpointHost: "vm.example",
      endpointPort: 22,
      adDomain: "example",
      adAccount: "person.one",
      targetAddress: "192.0.2.1",
      linuxAccount: "person_one",
      hostKeyAlgorithm: "ssh-ed25519",
      hostKeyPublicKey: "AAAA-test",
      hostKeyFingerprint: "SHA256:test",
    };
    const dependencies = createDependencies(async () => target);
    const provider = createPlatformClawExecutionTerminalProvider(
      dependencies,
      new PlatformClawTargetMutationCoordinator(),
    );

    const plan = await provider({ agentId: "person_one", config: {} as never });
    expect(plan).toMatchObject({
      shell: "person_one login shell",
      cwd: "/home/person_one",
      title: "Development VM",
    });
    await expect(plan.createProcess()).resolves.toMatchObject({ file: "ssh", args: ["vm"] });
    expect(dependencies.resolveTarget).toHaveBeenCalledTimes(2);
    expect(dependencies.createTerminalProcess).toHaveBeenCalledWith(target);
  });

  it("rejects a Basic workspace terminal", async () => {
    const dependencies = createDependencies(async ({ agentId }) => ({
      kind: "platform_server",
      agentId,
      revision: 1,
      targetId: "platform-server",
    }));
    const provider = createPlatformClawExecutionTerminalProvider(
      dependencies,
      new PlatformClawTargetMutationCoordinator(),
    );

    await expect(provider({ agentId: "person_one", config: {} as never })).rejects.toThrow(
      "only while My development VM is selected",
    );
    expect(dependencies.createTerminalProcess).not.toHaveBeenCalled();
  });
});
