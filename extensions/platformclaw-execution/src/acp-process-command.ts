import type { AcpProcessTransportLaunch } from "openclaw/plugin-sdk/acp-runtime-backend";
import { buildExecRemoteCommand, buildRemoteCommand } from "openclaw/plugin-sdk/sandbox";
import { buildAssignedVmProcessEnvironment, type AssignedVmTargetSnapshot } from "./backend.js";

const VM_ACP_COMMANDS = new Map<string, string[]>([
  ["claude", ["/opt/platformclaw/libexec/claude-agent-acp/bin/claude-agent-acp"]],
  ["codex", ["/opt/platformclaw/libexec/codex-acp/bin/codex-acp"]],
  ["opencode", ["/opt/platformclaw/libexec/opencode-acp/bin/opencode", "acp"]],
]);

export const PLATFORMCLAW_VM_ACP_AGENTS = new Set(VM_ACP_COMMANDS.keys());

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
  const argv = VM_ACP_COMMANDS.get(agent.trim().toLowerCase());
  if (!argv) {
    throw new Error(`Assigned VM ACP agent is unsupported: ${agent}`);
  }
  return argv;
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

export function buildAssignedVmCodingAgentVersionCommand(
  agent: "codex" | "opencode",
  target: Readonly<AssignedVmTargetSnapshot>,
): string {
  return buildExecRemoteCommand({
    command: `exec ${buildRemoteCommand([remoteAgentArgv(agent)[0]!, "--version"])}`,
    workdir: target.remoteWorkspaceDir,
    env: buildAssignedVmProcessEnvironment(target),
  });
}
