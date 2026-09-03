import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { AcpProcessTransportLaunch } from "openclaw/plugin-sdk/acp-runtime-backend";
import {
  buildSshSandboxArgv,
  disposeSshSandboxSession,
  sanitizeEnvVars,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import { buildAssignedVmAcpRemoteCommand } from "./acp-process-command.js";
import type { AssignedVmTargetSnapshot } from "./backend.js";

export const PLATFORMCLAW_VM_ACP_AGENTS = new Set(["claude", "opencode"]);

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
  const session = await params.createSession(params.target);
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    await disposeSshSandboxSession(session);
  };
  try {
    const remoteCommand = buildAssignedVmAcpRemoteCommand(params.input, params.target);
    const argv = buildSshSandboxArgv({ session, remoteCommand, tty: false });
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: process.cwd(),
      env: sanitizeEnvVars(process.env).allowed,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.once("close", () => void dispose().catch(() => {}));
    child.once("error", () => void dispose().catch(() => {}));
    await waitForSpawn(child);
    return child;
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}
