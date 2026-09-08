import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  AcpProcessTransportError,
  type AcpProcessTransportDiagnostic,
  type AcpProcessTransportLaunch,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import {
  buildSshSandboxArgv,
  disposeSshSandboxSession,
  runSshSandboxCommand,
  sanitizeEnvVars,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import {
  buildAssignedVmAcpDiagnosticCommand,
  buildAssignedVmAcpRemoteCommand,
} from "./acp-process-command.js";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import { classifyVmConnectionFailure } from "./connection-errors.js";

export const PLATFORMCLAW_VM_ACP_AGENTS = new Set(["claude", "opencode"]);
const ACP_DIAGNOSTIC_TIMEOUT_MS = 10_000;

function transportError(
  diagnostic: Omit<AcpProcessTransportDiagnostic, "ok">,
  cause: unknown,
): AcpProcessTransportError {
  return new AcpProcessTransportError(diagnostic, {
    cause: cause instanceof Error ? cause : undefined,
  });
}

async function waitForSpawn(
  child: ChildProcessByStdio<Writable, Readable, Readable>,
): Promise<void> {
  if (child.pid) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

export async function launchAssignedVmAcpProcess(params: {
  input: AcpProcessTransportLaunch;
  target: Readonly<AssignedVmTargetSnapshot>;
  createSession: (target: AssignedVmTargetSnapshot) => Promise<SshSandboxSession>;
}): Promise<ChildProcessByStdio<Writable, Readable, Readable>> {
  let session: SshSandboxSession;
  try {
    session = await params.createSession(params.target);
  } catch (error) {
    const failure = classifyVmConnectionFailure(error);
    throw transportError(
      {
        stage: "ssh",
        code: failure.kind,
        message: `Assigned VM ACP SSH session failed: ${failure.message}.`,
        retryable: failure.code === "UNAVAILABLE",
      },
      error,
    );
  }
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    await disposeSshSandboxSession(session);
  };
  try {
    try {
      await runSshSandboxCommand({
        session,
        remoteCommand: buildAssignedVmAcpDiagnosticCommand(params.input.agent, params.target),
        signal: AbortSignal.timeout(ACP_DIAGNOSTIC_TIMEOUT_MS),
        maxBufferBytes: 1_024,
      });
    } catch (error) {
      const remote = diagnosticForRemoteExit(error);
      if (remote) {
        throw transportError(remote, error);
      }
      const failure = classifyVmConnectionFailure(error);
      throw transportError(
        {
          stage: "ssh",
          code: failure.kind,
          message: `Assigned VM ACP preflight failed: ${failure.message}.`,
          retryable: failure.code === "UNAVAILABLE",
        },
        error,
      );
    }
    const remoteCommand = buildAssignedVmAcpRemoteCommand(params.input, params.target);
    const argv = buildSshSandboxArgv({ session, remoteCommand, tty: false });
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: process.cwd(),
        env: sanitizeEnvVars(process.env).allowed,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      await waitForSpawn(child);
    } catch (error) {
      throw transportError(
        {
          stage: "ssh",
          code: "ssh_client_spawn_failed",
          message:
            "Assigned VM ACP SSH client could not start. Verify OpenSSH is installed in the Gateway image.",
        },
        error,
      );
    }
    child.once("close", () => void dispose().catch(() => {}));
    child.once("error", () => void dispose().catch(() => {}));
    return child;
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}

function diagnosticForRemoteExit(error: unknown): AcpProcessTransportDiagnostic | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case 120:
      return {
        ok: false,
        stage: "adapter",
        code: "adapter_missing",
        message:
          "Assigned VM ACP adapter is not installed. Install the PlatformClaw VM ACP adapter bundle.",
      };
    case 121:
      return {
        ok: false,
        stage: "adapter",
        code: "adapter_not_executable",
        message:
          "Assigned VM ACP adapter is not executable. Repair the adapter installation permissions.",
      };
    case 122:
      return {
        ok: false,
        stage: "adapter",
        code: "agent_executable_missing",
        message:
          "Claude Code is not installed at the configured user path. Update the personal Claude Code executable setting.",
      };
    case 123:
      return {
        ok: false,
        stage: "adapter",
        code: "agent_executable_not_executable",
        message:
          "Claude Code is not executable at the configured user path. Repair the personal installation permissions.",
      };
    default:
      return undefined;
  }
}

export async function diagnoseAssignedVmAcpProcess(params: {
  agent: string;
  target: Readonly<AssignedVmTargetSnapshot>;
  createSession: (target: AssignedVmTargetSnapshot) => Promise<SshSandboxSession>;
  signal?: AbortSignal;
}): Promise<AcpProcessTransportDiagnostic> {
  let session: SshSandboxSession;
  try {
    session = await params.createSession(params.target);
  } catch (error) {
    const failure = classifyVmConnectionFailure(error);
    return {
      ok: false,
      stage: "ssh",
      code: failure.kind,
      message: `Assigned VM ACP SSH session failed: ${failure.message}.`,
      retryable: failure.code === "UNAVAILABLE",
    };
  }
  try {
    const timeout = AbortSignal.timeout(ACP_DIAGNOSTIC_TIMEOUT_MS);
    const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
    await runSshSandboxCommand({
      session,
      remoteCommand: buildAssignedVmAcpDiagnosticCommand(params.agent, params.target),
      signal,
      maxBufferBytes: 1_024,
    });
    return {
      ok: true,
      stage: "ready",
      code: "ready",
      message: `Assigned VM ACP launch prerequisites are ready for ${params.agent}. Authentication and ACP initialization are checked when a session starts.`,
    };
  } catch (error) {
    const remote = diagnosticForRemoteExit(error);
    if (remote) {
      return remote;
    }
    const failure = classifyVmConnectionFailure(error);
    return {
      ok: false,
      stage: "ssh",
      code: failure.kind,
      message: `Assigned VM ACP preflight failed: ${failure.message}.`,
      retryable: failure.code === "UNAVAILABLE",
    };
  } finally {
    await disposeSshSandboxSession(session).catch(() => {});
  }
}
