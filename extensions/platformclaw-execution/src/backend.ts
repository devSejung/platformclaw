import type {
  CreateSandboxBackendParams,
  SandboxBackendFactory,
  SandboxBackendHandle,
} from "openclaw/plugin-sdk/sandbox";

export const PLATFORMCLAW_EXECUTION_BACKEND_ID = "platformclaw-execution";

type ExecutionTargetBase = {
  agentId: string;
  revision: number;
  targetId: string;
};

export type PlatformServerTargetSnapshot = ExecutionTargetBase & {
  kind: "platform_server";
};

export type AssignedVmTargetSnapshot = ExecutionTargetBase & {
  kind: "assigned_vm";
  allocationId: string;
  remoteWorkspaceDir: string;
};

export type PlatformClawExecutionTargetSnapshot =
  | PlatformServerTargetSnapshot
  | AssignedVmTargetSnapshot;

export type PlatformClawExecutionTargetResolver = (params: {
  agentId: string;
}) => Promise<PlatformClawExecutionTargetSnapshot>;

type TargetHandleFactory<TTarget extends PlatformClawExecutionTargetSnapshot> = (params: {
  createParams: CreateSandboxBackendParams;
  target: Readonly<TTarget>;
}) => Promise<SandboxBackendHandle>;

export type PlatformClawExecutionDependencies = {
  resolveTarget: PlatformClawExecutionTargetResolver;
  createPlatformServerHandle: TargetHandleFactory<PlatformServerTargetSnapshot>;
  createAssignedVmHandle: TargetHandleFactory<AssignedVmTargetSnapshot>;
};

export function createPlatformClawExecutionBackendFactory(
  dependencies: PlatformClawExecutionDependencies,
): SandboxBackendFactory {
  return async (createParams) => {
    const agentId = createParams.agentId;
    if (!agentId?.trim()) {
      throw new Error("PlatformClaw execution requires a prepared agent owner.");
    }

    // Resolve exactly once per context creation. The copied snapshot keeps a
    // target change from redirecting an already-prepared run mid-execution.
    const target = pinTargetSnapshot(await dependencies.resolveTarget({ agentId }), agentId);
    const handle =
      target.kind === "platform_server"
        ? await dependencies.createPlatformServerHandle({ createParams, target })
        : await dependencies.createAssignedVmHandle({ createParams, target });

    return {
      ...handle,
      id: PLATFORMCLAW_EXECUTION_BACKEND_ID,
    };
  };
}

export function createUnavailableExecutionDependencies(): PlatformClawExecutionDependencies {
  const unavailable = async (): Promise<never> => {
    throw new Error("PlatformClaw execution target resolution is not configured.");
  };
  return {
    resolveTarget: unavailable,
    createPlatformServerHandle: unavailable,
    createAssignedVmHandle: unavailable,
  };
}

function pinTargetSnapshot(
  candidate: PlatformClawExecutionTargetSnapshot,
  agentId: string,
): Readonly<PlatformClawExecutionTargetSnapshot> {
  if (candidate.agentId !== agentId) {
    throw new Error("PlatformClaw execution target owner does not match the prepared agent.");
  }
  if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 0) {
    throw new Error("PlatformClaw execution target revision is invalid.");
  }
  if (!candidate.targetId.trim()) {
    throw new Error("PlatformClaw execution target id is missing.");
  }
  if (candidate.kind === "assigned_vm") {
    if (!candidate.allocationId.trim() || !candidate.remoteWorkspaceDir.trim()) {
      throw new Error("PlatformClaw VM allocation snapshot is incomplete.");
    }
  }
  return Object.freeze({ ...candidate });
}
