import {
  disposeSshSandboxSession,
  runSshSandboxCommand,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import { buildAssignedVmCodingAgentVersionCommand } from "./acp-process-command.js";
import type { AssignedVmTargetSnapshot } from "./backend.js";

export async function validateAssignedVmCodingAgent(params: {
  target: AssignedVmTargetSnapshot;
  agent: "codex" | "opencode";
  createSession: (target: AssignedVmTargetSnapshot) => Promise<SshSandboxSession>;
}) {
  const session = await params.createSession(params.target);
  try {
    const result = await runSshSandboxCommand({
      session,
      remoteCommand: buildAssignedVmCodingAgentVersionCommand(params.agent, params.target),
      signal: AbortSignal.timeout(15_000),
      maxBufferBytes: 4096,
    });
    const reportedVersion = result.stdout.toString("utf8").trim();
    if (!reportedVersion || reportedVersion.length > 512 || /\p{Cc}/u.test(reportedVersion)) {
      throw new Error("coding agent returned an invalid version");
    }
    return {
      agent: params.agent,
      allocationId: params.target.allocationId,
      targetRevision: params.target.revision,
      reportedVersion,
    };
  } finally {
    await disposeSshSandboxSession(session);
  }
}
