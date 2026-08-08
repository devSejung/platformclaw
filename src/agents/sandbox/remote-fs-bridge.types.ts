import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
} from "./backend-handle.types.js";
import type { SandboxResolvedPath } from "./fs-bridge.types.js";
import type { RemoteMountSource } from "./remote-fs-bridge-paths.js";

export type ResolvedRemotePath = SandboxResolvedPath & {
  writable: boolean;
  mountRootPath: string;
  source: RemoteMountSource;
};

/** Extra remote-only root exposed by a caller-owned SSH runtime. */
export type RemoteShellSandboxFilesystemRoot = {
  root: string;
  access: "ro" | "rw";
};

/** Minimal remote shell contract used by the SSH filesystem bridge. */
export type RemoteShellSandboxHandle = {
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  /** Canonical login home for model-facing `~` and `~/...` paths. */
  remoteHomeDir?: string;
  additionalFilesystemRoots?: readonly RemoteShellSandboxFilesystemRoot[];
  runRemoteShellScript(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
};
