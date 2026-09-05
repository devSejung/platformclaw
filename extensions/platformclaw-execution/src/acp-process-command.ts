import type { AcpProcessTransportLaunch } from "openclaw/plugin-sdk/acp-runtime-backend";
import { buildExecRemoteCommand, buildRemoteCommand } from "openclaw/plugin-sdk/sandbox";
import { buildAssignedVmProcessEnvironment, type AssignedVmTargetSnapshot } from "./backend.js";

const CLAUDE_ADAPTER = "/opt/platformclaw/libexec/claude-agent-acp/bin/claude-agent-acp";
const OPENCODE_ADAPTER = "/opt/platformclaw/libexec/opencode-acp/bin/opencode";

function remoteAgentArgv(agent: string): string[] {
  switch (agent.trim().toLowerCase()) {
    case "claude":
      return [CLAUDE_ADAPTER];
    case "opencode":
      return [OPENCODE_ADAPTER, "acp"];
    default:
      throw new Error(`Assigned VM ACP agent is unsupported: ${agent}`);
  }
}

export function buildAssignedVmAcpRemoteCommand(
  input: AcpProcessTransportLaunch,
  target: Readonly<AssignedVmTargetSnapshot>,
): string {
  return buildExecRemoteCommand({
    command: `exec ${buildRemoteCommand(remoteAgentArgv(input.agent))}`,
    workdir: target.remoteWorkspaceDir,
    env: buildAssignedVmProcessEnvironment(target),
  });
}
