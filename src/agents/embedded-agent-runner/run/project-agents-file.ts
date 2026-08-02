import path from "node:path";
import type { SandboxContext } from "../../sandbox/types.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../../workspace-bootstrap-read.js";
import { DEFAULT_AGENTS_FILENAME, type WorkspaceBootstrapFile } from "../../workspace.js";

export async function loadProjectAgentsFile(params: {
  sandbox?: SandboxContext | null;
  logicalWorkspaceDir: string;
}): Promise<WorkspaceBootstrapFile | undefined> {
  const sandbox = params.sandbox;
  if (sandbox?.backend?.capabilities?.separateAgentWorkspace !== true) {
    return undefined;
  }
  const bridge = sandbox.fsBridge;
  if (!bridge) {
    throw new Error("Project instruction filesystem bridge is unavailable.");
  }
  const remotePath = path.posix.join(sandbox.containerWorkdir, DEFAULT_AGENTS_FILENAME);
  const logicalPath = path.join(params.logicalWorkspaceDir, DEFAULT_AGENTS_FILENAME);
  const stat = await bridge.stat({ filePath: remotePath });
  if (!stat) {
    return { name: DEFAULT_AGENTS_FILENAME, path: logicalPath, missing: true };
  }
  if (stat.type !== "file") {
    throw new Error("Project AGENTS.md is not a regular file.");
  }
  const content = await bridge.readFile({
    filePath: remotePath,
    maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  });
  return {
    name: DEFAULT_AGENTS_FILENAME,
    path: logicalPath,
    content: content.toString("utf8"),
    missing: false,
  };
}
