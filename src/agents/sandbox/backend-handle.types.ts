import type { SkillWorkshopTargetAccess } from "../../skills/workshop/types.js";
/**
 * Backend-neutral sandbox runtime handle contracts.
 *
 * Docker, SSH, and future sandbox providers implement these command, exec, and fs-bridge surfaces.
 */
import type { SandboxFsBridge } from "./fs-bridge.types.js";

/**
 * Backend-neutral sandbox runtime handles used by Docker, SSH, and future sandbox providers.
 */
export type SandboxBackendId = string;

/** Shell exec specification prepared by a sandbox backend for process launch. */
export type SandboxBackendExecSpec = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdinMode: "pipe-open" | "pipe-closed";
  finalizeToken?: unknown;
};

export type SandboxBackendWorkdirValidation = "host" | "backend";

export type SandboxBackendWorkdirValidator = (workdir: string) => Promise<string | null>;
export type SandboxBackendPreparedWorkdirDiscarder = (workdir: string) => void;

/** Parameters for backend-managed shell commands used by fs bridges and probes. */
export type SandboxBackendCommandParams = {
  script: string;
  args?: string[];
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
};

/** Buffered command result returned by sandbox backend shell helpers. */
export type SandboxBackendCommandResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
};

/** One skill file prepared by a backend that owns the execution filesystem. */
export type SandboxBackendSkillFile = {
  content: string;
  filePath: string;
  locationNote?: string;
  source: string;
};

/** Immutable skill catalog pinned to the same target as one backend handle. */
export type SandboxBackendSkillCatalog = {
  revision: string;
  files: readonly SandboxBackendSkillFile[];
  eligibility?: {
    bins: readonly string[];
    platforms: readonly string[];
  };
};

/** Runtime context passed to backend-provided filesystem bridge factories. */
export type SandboxFsBridgeContext = {
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workspaceAccess: "none" | "ro" | "rw";
  containerName: string;
  containerWorkdir: string;
  docker: {
    binds?: string[];
  };
  backend?: {
    runShellCommand(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
  };
};

/** Live sandbox backend handle for command execution, cleanup, and optional fs bridge creation. */
export type SandboxBackendHandle = {
  id: SandboxBackendId;
  runtimeId: string;
  runtimeLabel: string;
  workdir: string;
  env?: Record<string, string>;
  configLabel?: string;
  configLabelKind?: string;
  /**
   * Remote backends own cwd existence checks because valid runtime paths may
   * not exist in the local workspace mirror. Backend validation must be paired
   * with validateWorkdir so cwd is proved after before_tool_call adjustments
   * and before env resolution, approval, preflight, and launch.
   */
  workdirValidation?: SandboxBackendWorkdirValidation;
  validateWorkdir?: SandboxBackendWorkdirValidator;
  /** Discard one-shot state created while validating a backend-owned cwd. */
  discardPreparedWorkdir?: SandboxBackendPreparedWorkdirDiscarder;
  /** Remote cwd roots managed by backend validation. Defaults to workdir. */
  workdirRoots?: readonly string[];
  /** Replaces gateway-local discovery when the backend owns a remote filesystem. */
  skillCatalog?: SandboxBackendSkillCatalog;
  /**
   * Backend-owned, credential-free context pinned to this execution handle.
   * Embedded runs deliver it as hidden runtime context, never user-authored text.
   */
  runtimePromptContext?: string;
  /** Mutable Workshop target pinned to the same execution target as this handle. */
  skillWorkshopTarget?: SkillWorkshopTargetAccess | { kind: "workspace" };
  capabilities?: {
    browser?: boolean;
  };
  buildExecSpec(params: {
    command: string;
    workdir?: string;
    env: Record<string, string>;
    usePty: boolean;
  }): Promise<SandboxBackendExecSpec>;
  finalizeExec?: (params: {
    status: "completed" | "failed";
    exitCode: number | null;
    timedOut: boolean;
    token?: unknown;
  }) => Promise<void>;
  runShellCommand(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
  createFsBridge?: (params: { sandbox: SandboxFsBridgeContext }) => SandboxFsBridge;
};
