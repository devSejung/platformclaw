/**
 * Shared sandbox backend registration contracts.
 *
 * Runtime creation and lifecycle cleanup stay behind this backend boundary.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillWorkshopTargetAccess } from "../../skills/workshop/types.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import type { SandboxBackendSkillCatalog } from "./backend-handle.types.js";
import type { SandboxRegistryEntry } from "./registry.js";
import type { SandboxConfig } from "./types.js";

/** Current runtime state reported by a sandbox backend manager. */
export type SandboxBackendRuntimeInfo = {
  running: boolean;
  actualConfigLabel?: string;
  configLabelMatch: boolean;
};

/** Optional lifecycle manager for an existing registered sandbox runtime. */
export type SandboxBackendManager = {
  describeRuntime(params: {
    entry: SandboxRegistryEntry;
    config: OpenClawConfig;
    agentId?: string;
  }): Promise<SandboxBackendRuntimeInfo>;
  removeRuntime(params: {
    entry: SandboxRegistryEntry;
    config: OpenClawConfig;
    agentId?: string;
  }): Promise<void>;
};

/** Inputs needed to create a sandbox backend handle for one session scope. */
export type CreateSandboxBackendParams = {
  /** Resolved agent owner when the runtime entry point can identify it. */
  agentId?: string;
  sessionKey: string;
  scopeKey: string;
  /** Runtime IDs already registered for this backend and scope, newest first. */
  registeredRuntimeIds?: readonly string[];
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  /**
   * Materializes Gateway-owned skills before a deferred backend creates runtime mounts.
   * Present only when the backend registers `skillMaterialization: "backend-deferred"`.
   */
  materializeSkills?: () => Promise<void>;
  cfg: SandboxConfig;
  requireCurrentConfig?: boolean;
};

/** Lets a dynamic backend choose between Gateway skills and a target-owned catalog. */
export type SandboxBackendSkillMaterializationMode = "backend-deferred";

/** Factory that creates a backend handle for a sandbox session. */
export type SandboxBackendFactory = (
  params: CreateSandboxBackendParams,
) => Promise<SandboxBackendHandle>;

/** Resolve the runtime workdir without creating or starting the backend. */
export type SandboxBackendWorkdirResolver = (params: CreateSandboxBackendParams) => string;

/** Lists target-owned skills without creating a run-scoped backend handle. */
export type SandboxBackendSkillProvider = (params: {
  agentId: string;
  config: OpenClawConfig;
  refresh: boolean;
  workspaceDir: string;
}) => Promise<SandboxBackendSkillCatalog | undefined>;

/** Resolves mutable Workshop access for the agent's current execution target. */
export type SandboxBackendSkillWorkshopProvider = (params: {
  agentId: string;
  config: OpenClawConfig;
  workspaceDir: string;
}) => Promise<SkillWorkshopTargetAccess | undefined>;

/** Registry input accepted for sandbox backend registration. */
export type SandboxBackendRegistration =
  | SandboxBackendFactory
  | {
      factory: SandboxBackendFactory;
      manager?: SandboxBackendManager;
      resolveWorkdir?: SandboxBackendWorkdirResolver;
      skills?: SandboxBackendSkillProvider;
      skillMaterialization?: SandboxBackendSkillMaterializationMode;
      skillWorkshop?: SandboxBackendSkillWorkshopProvider;
    };

/** Normalized backend registration stored in the sandbox backend registry. */
export type RegisteredSandboxBackend = {
  factory: SandboxBackendFactory;
  manager?: SandboxBackendManager;
  resolveWorkdir?: SandboxBackendWorkdirResolver;
  skills?: SandboxBackendSkillProvider;
  skillMaterialization?: SandboxBackendSkillMaterializationMode;
  skillWorkshop?: SandboxBackendSkillWorkshopProvider;
};

export type { SandboxBackendHandle, SandboxBackendId } from "./backend-handle.types.js";
export type { SandboxBackendWorkdirValidation } from "./backend-handle.types.js";
