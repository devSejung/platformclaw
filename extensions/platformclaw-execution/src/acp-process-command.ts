import type { AcpProcessTransportLaunch } from "openclaw/plugin-sdk/acp-runtime-backend";
import { buildExecRemoteCommand, buildRemoteCommand } from "openclaw/plugin-sdk/sandbox";
import { buildAssignedVmProcessEnvironment, type AssignedVmTargetSnapshot } from "./backend.js";

const CLAUDE_ADAPTER = "/opt/platformclaw/libexec/claude-agent-acp/bin/claude-agent-acp";
const OPENCODE_ADAPTER = "/opt/platformclaw/libexec/opencode-acp/bin/opencode";

const REMOTE_LAUNCH_SCRIPT = [
  "set -eu",
  'adapter="$1"',
  'agent="$2"',
  'mode="$3"',
  '[ -f "$adapter" ] || { echo "Assigned VM ACP adapter is not installed. Install the PlatformClaw VM ACP adapter bundle." >&2; exit 120; }',
  '[ -x "$adapter" ] || { echo "Assigned VM ACP adapter is not executable. Repair the adapter installation permissions." >&2; exit 121; }',
  'if [ "$agent" = claude ]; then',
  "  claude_executable=${CLAUDE_CODE_EXECUTABLE:-}",
  '  [ -n "$claude_executable" ] || claude_executable=$(command -v claude || true)',
  '  [ -f "$claude_executable" ] || { echo "Claude Code is not installed at the configured user path. Update the personal Claude Code executable setting." >&2; exit 122; }',
  '  [ -x "$claude_executable" ] || { echo "Claude Code is not executable at the configured user path. Repair the personal installation permissions." >&2; exit 123; }',
  '  export CLAUDE_CODE_EXECUTABLE="$claude_executable"',
  "fi",
  '[ "$mode" = check ] && exit 0',
  'if [ "$agent" = opencode ]; then exec "$adapter" acp; fi',
  'exec "$adapter"',
].join("\n");

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
    command: buildRemoteCommand([
      "/bin/sh",
      "-c",
      REMOTE_LAUNCH_SCRIPT,
      "platformclaw-acp-launch",
      ...remoteAgentArgv(input.agent).slice(0, 1),
      input.agent.trim().toLowerCase(),
      "launch",
    ]),
    workdir: target.remoteWorkspaceDir,
    env: buildAssignedVmProcessEnvironment(target),
  });
}

export function buildAssignedVmAcpDiagnosticCommand(
  agent: string,
  target: Readonly<AssignedVmTargetSnapshot>,
): string {
  return buildExecRemoteCommand({
    command: buildRemoteCommand([
      "/bin/sh",
      "-c",
      REMOTE_LAUNCH_SCRIPT,
      "platformclaw-acp-check",
      ...remoteAgentArgv(agent).slice(0, 1),
      agent.trim().toLowerCase(),
      "check",
    ]),
    workdir: target.remoteWorkspaceDir,
    env: buildAssignedVmProcessEnvironment(target),
  });
}
