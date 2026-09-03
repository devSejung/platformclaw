import {
  buildRemoteCommand,
  disposeSshSandboxSession,
  runSshSandboxCommand,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import type { AssignedVmTargetSnapshot } from "./backend.js";

export async function validateAssignedVmClaudeCode(params: {
  target: AssignedVmTargetSnapshot;
  executablePath?: string;
  createSession: (target: AssignedVmTargetSnapshot) => Promise<SshSandboxSession>;
}): Promise<{
  allocationId: string;
  targetRevision: number;
  executablePath: string;
  reportedVersion: string;
}> {
  const session = await params.createSession(params.target);
  const script = [
    "set -eu",
    'candidate="$1"',
    '[ -n "$candidate" ] || candidate=$(command -v claude || true)',
    '[ -n "$candidate" ] || { echo "Claude Code was not found" >&2; exit 127; }',
    'canonical=$(readlink -f -- "$candidate")',
    '[ -x "$canonical" ] || { echo "Claude Code is not executable" >&2; exit 126; }',
    'version=$("$canonical" --version 2>&1 | head -c 512)',
    '[ -n "$version" ] || { echo "Claude Code version was empty" >&2; exit 1; }',
    'printf "%s\\n%s\\n" "$(printf %s "$canonical" | base64 -w0)" "$(printf %s "$version" | base64 -w0)"',
  ].join("\n");
  try {
    const result = await runSshSandboxCommand({
      session,
      remoteCommand: buildRemoteCommand([
        "/bin/sh",
        "-c",
        script,
        "platformclaw-claude-code-probe",
        params.executablePath ?? "",
      ]),
      signal: AbortSignal.timeout(15_000),
      maxBufferBytes: 4096,
    });
    const [encodedPath, encodedVersion] = result.stdout.toString("utf8").trim().split(/\r?\n/u);
    const executablePath = Buffer.from(encodedPath ?? "", "base64").toString("utf8");
    const reportedVersion = Buffer.from(encodedVersion ?? "", "base64").toString("utf8");
    if (
      !executablePath.startsWith("/") ||
      !reportedVersion ||
      executablePath.length > 4096 ||
      reportedVersion.length > 512
    ) {
      throw new Error("Claude Code returned an invalid validation result");
    }
    return {
      allocationId: params.target.allocationId,
      targetRevision: params.target.revision,
      executablePath,
      reportedVersion,
    };
  } finally {
    await disposeSshSandboxSession(session);
  }
}
