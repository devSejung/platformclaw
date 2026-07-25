import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import {
  createSshSandboxBackendWithSessionFactory,
  createSshSandboxSessionFromConfigText,
  disposeSshSandboxSession,
  requireSandboxBackendFactory,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import type {
  AssignedVmTargetSnapshot,
  PlatformClawExecutionDependencies,
  PlatformClawExecutionTargetSnapshot,
} from "./backend.js";
import { VmRemoteSkillCatalogService } from "./remote-skills.js";

const KNOWN_HOSTS_PLACEHOLDER = "/platformclaw/known-hosts-placeholder";
const EXECUTION_TARGET_PATH = "/platformclaw/internal/execution/target";
const MAX_HANDOFF_RESPONSE_BYTES = 8 * 1024;

function requireSingleLine(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/u.test(trimmed) || trimmed.includes(String.fromCharCode(0))) {
    throw new Error(`${label} is invalid`);
  }
  return trimmed;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is invalid`);
  }
  return requireSingleLine(value, label);
}

function requireSshToken(value: unknown, label: string): string {
  const token = requireString(value, label);
  if (/\s/u.test(token)) {
    throw new Error(`${label} is invalid`);
  }
  return token;
}

export function quoteOpenSshConfigPath(value: string): string {
  const pathValue = requireSingleLine(value, "SSH configuration path");
  if (pathValue.includes("${")) {
    throw new Error("SSH configuration path contains unsupported expansion syntax");
  }
  return `"${pathValue.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function executionHandoffAddress(credentialBrokerAddress: string): string {
  return process.platform === "win32"
    ? `${credentialBrokerAddress}-execution`
    : path.join(path.dirname(credentialBrokerAddress), "execution.sock");
}

async function resolveExecutionTarget(params: {
  socketPath: string;
  serviceToken: string;
  agentId: string;
}): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify({ agentId: params.agentId }));
  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const req = request(
      {
        socketPath: params.socketPath,
        path: EXECUTION_TARGET_PATH,
        method: "POST",
        headers: {
          authorization: `Bearer ${params.serviceToken}`,
          "content-type": "application/json",
          "content-length": payload.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_HANDOFF_RESPONSE_BYTES) {
            const error = new Error("execution target response exceeded the limit");
            fail(error);
            req.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        res.once("end", () => {
          if (settled) {
            return;
          }
          const status = res.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            fail(new Error(`execution target request failed (${status})`));
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            settled = true;
            resolve(parsed);
          } catch {
            fail(new Error("execution target response is invalid"));
          }
        });
        res.once("aborted", () => fail(new Error("execution target response was aborted")));
        res.once("error", fail);
      },
    );
    req.setTimeout(5_000, () => req.destroy(new Error("execution target request timed out")));
    req.once("error", fail);
    req.end(payload);
  });
}

function parseTarget(value: unknown): PlatformClawExecutionTargetSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("execution target is invalid");
  }
  const target = value as Record<string, unknown>;
  const base = {
    kind: target.kind,
    agentId: requireString(target.agentId, "agent id"),
    targetId: requireString(target.targetId, "target id"),
    revision: Number(target.revision),
  };
  if (target.kind === "platform_server") {
    return base as PlatformClawExecutionTargetSnapshot;
  }
  if (target.kind !== "assigned_vm") {
    throw new Error("execution target kind is invalid");
  }
  return {
    ...base,
    kind: "assigned_vm",
    allocationId: requireString(target.allocationId, "allocation id"),
    endpointHost: requireSshToken(target.endpointHost, "endpoint host"),
    endpointPort: Number(target.endpointPort),
    adDomain: requireSshToken(target.adDomain, "AD domain"),
    adAccount: requireSshToken(target.adAccount, "AD account"),
    targetAddress: requireSshToken(target.targetAddress, "VM address"),
    linuxAccount: requireSshToken(target.linuxAccount, "Linux account"),
    remoteWorkspaceDir: requireString(target.remoteWorkspaceDir, "remote workspace"),
    hostKeyAlgorithm: requireSshToken(target.hostKeyAlgorithm, "host key algorithm"),
    hostKeyPublicKey: requireSshToken(target.hostKeyPublicKey, "host public key"),
    hostKeyFingerprint: requireString(target.hostKeyFingerprint, "host key fingerprint"),
  };
}

function safeConnectConfig(target: AssignedVmTargetSnapshot): string {
  if (
    !Number.isInteger(target.endpointPort) ||
    target.endpointPort < 1 ||
    target.endpointPort > 65535
  ) {
    throw new Error("SafeConnect endpoint port is invalid");
  }
  const endpointHost = requireSshToken(target.endpointHost, "endpoint host");
  const adDomain = requireSshToken(target.adDomain, "AD domain");
  const adAccount = requireSshToken(target.adAccount, "AD account");
  const linuxAccount = requireSshToken(target.linuxAccount, "Linux account");
  const targetAddress = requireSshToken(target.targetAddress, "VM address");
  const user = `${adDomain}\\${adAccount}+${linuxAccount}+${targetAddress}`;
  return [
    "Host platformclaw-safeconnect",
    `  HostName ${endpointHost}`,
    `  Port ${target.endpointPort}`,
    `  User ${user}`,
    "  BatchMode no",
    "  PreferredAuthentications keyboard-interactive",
    "  KbdInteractiveAuthentication yes",
    "  PasswordAuthentication no",
    "  NumberOfPasswordPrompts 1",
    "  ConnectTimeout 5",
    "  ServerAliveInterval 30",
    "  ServerAliveCountMax 6",
    "  TCPKeepAlive yes",
    "  ControlMaster no",
    "  ControlPath none",
    "  StrictHostKeyChecking yes",
    "  UpdateHostKeys no",
    `  UserKnownHostsFile ${KNOWN_HOSTS_PLACEHOLDER}`,
    "  GlobalKnownHostsFile /dev/null",
    "",
  ].join("\n");
}

export async function createSafeConnectSession(
  target: AssignedVmTargetSnapshot,
  launcher = "/usr/local/bin/platformclaw-sshpass",
): Promise<SshSandboxSession> {
  const session = await createSshSandboxSessionFromConfigText({
    configText: safeConnectConfig(target),
    host: "platformclaw-safeconnect",
    command: launcher,
  });
  try {
    const sessionDir = path.dirname(session.configPath);
    const knownHostsPath = path.join(sessionDir, "known_hosts");
    const hostPattern =
      target.endpointPort === 22
        ? target.endpointHost
        : `[${target.endpointHost}]:${target.endpointPort}`;
    const hostKeyAlgorithm = requireSshToken(target.hostKeyAlgorithm, "host key algorithm");
    const hostKeyPublicKey = requireSshToken(target.hostKeyPublicKey, "host public key");
    await Promise.all([
      writeFile(knownHostsPath, `${hostPattern} ${hostKeyAlgorithm} ${hostKeyPublicKey}\n`, {
        mode: 0o600,
      }),
      writeFile(
        path.join(sessionDir, "platformclaw-context.json"),
        JSON.stringify({
          agentId: target.agentId,
          allocationId: target.allocationId,
          targetRevision: target.revision,
        }),
        { mode: 0o600 },
      ),
    ]);
    const config = await readFile(session.configPath, "utf8");
    await writeFile(
      session.configPath,
      config.replace(KNOWN_HOSTS_PLACEHOLDER, quoteOpenSshConfigPath(knownHostsPath)),
      { mode: 0o600 },
    );
    return session;
  } catch (error) {
    await disposeSshSandboxSession(session);
    throw error;
  }
}

export async function createExecutionDependenciesFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlatformClawExecutionDependencies> {
  const brokerAddress = requireSingleLine(
    env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS ?? "",
    "credential broker address",
  );
  const tokenFile = requireSingleLine(
    env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE ?? "",
    "execution token file",
  );
  const serviceToken = (await readFile(tokenFile, "utf8")).trim();
  if (!serviceToken) {
    throw new Error("execution service token is empty");
  }
  const remoteSkills = new VmRemoteSkillCatalogService();
  return {
    resolveTarget: async ({ agentId }) => {
      return parseTarget(
        await resolveExecutionTarget({
          socketPath: executionHandoffAddress(brokerAddress),
          serviceToken,
          agentId,
        }),
      );
    },
    createPlatformServerHandle: async ({ createParams }) =>
      await requireSandboxBackendFactory("docker")(createParams),
    createAssignedVmHandle: async ({ createParams, target }) =>
      await createSshSandboxBackendWithSessionFactory(createParams, {
        targetLabel: `${target.endpointHost}:${target.endpointPort}`,
        workspaceRoot: target.remoteWorkspaceDir,
        workspaceMode: "existing",
        createSession: async () => await createSafeConnectSession(target),
      }),
    listTargetSkills: async ({ refresh, target }) =>
      target.kind === "assigned_vm" ? await remoteSkills.list(target, refresh) : undefined,
  };
}
