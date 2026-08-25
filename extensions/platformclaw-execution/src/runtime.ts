import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import {
  createSshSandboxBackendWithSessionFactory,
  buildSshLoginShellArgv,
  createSshSandboxSessionFromConfigText,
  disposeSshSandboxSession,
  requireSandboxBackendFactory,
  runSshSandboxCommand,
  uploadDirectoryToSshTarget,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import type {
  AssignedVmTargetSnapshot,
  PlatformClawExecutionDependencies,
  PlatformClawExecutionTargetSnapshot,
} from "./backend.js";
import {
  isSshpassAuthenticationFailure,
  PlatformClawVmAuthenticationError,
} from "./connection-errors.js";
import { VmRemoteSkillExportService } from "./remote-skill-export.js";
import { VmRemoteSkillInstallerService } from "./remote-skill-install.js";
import { VmRemoteSkillWorkshopService } from "./remote-skill-workshop.js";
import { VmRemoteSkillCatalogService } from "./remote-skills.js";
import type { PlatformClawSkillExportRuntime } from "./skill-export-gateway.js";
import { SafeConnectSshLeaseManager } from "./ssh-lease-manager.js";

const KNOWN_HOSTS_PLACEHOLDER = "/platformclaw/known-hosts-placeholder";
const EXECUTION_TARGET_PATH = "/platformclaw/internal/execution/target";
const EXECUTION_CONNECTION_TARGET_PATH = "/platformclaw/internal/execution/connection-target";
const EXECUTION_CHANGE_TARGET_PATH = "/platformclaw/internal/execution/change-target";
const EXECUTION_CREDENTIALS_PATH = "/platformclaw/internal/execution/credentials";
const MAX_HANDOFF_RESPONSE_BYTES = 512 * 1024;
const VM_CONNECTION_TEST_TIMEOUT_MS = 15_000;
const VM_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const VM_ENV_BLOCKED_NAMES = new Set([
  "BASHOPTS",
  "BASH_ENV",
  "CDPATH",
  "ENV",
  "GLOBIGNORE",
  "HOME",
  "IFS",
  "LOGNAME",
  "NODE_OPTIONS",
  "PATH",
  "PWD",
  "SHELL",
  "SHELLOPTS",
  "TMPDIR",
  "USER",
]);

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

function parseExecutionEnvironment(
  value: unknown,
): NonNullable<AssignedVmTargetSnapshot["executionEnvironment"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("VM execution environment is invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.pathPrepend) || candidate.pathPrepend.length > 32) {
    throw new Error("VM execution PATH is invalid");
  }
  const pathPrepend = candidate.pathPrepend.map((entry) => {
    const normalized = requireString(entry, "VM execution PATH");
    if (
      !path.posix.isAbsolute(normalized) ||
      path.posix.normalize(normalized) !== normalized ||
      normalized.includes(":")
    ) {
      throw new Error("VM execution PATH is invalid");
    }
    return normalized;
  });
  if (
    !candidate.variables ||
    typeof candidate.variables !== "object" ||
    Array.isArray(candidate.variables)
  ) {
    throw new Error("VM execution variables are invalid");
  }
  const entries = Object.entries(candidate.variables);
  if (entries.length > 64) {
    throw new Error("VM execution variables are invalid");
  }
  const variables: Record<string, string> = {};
  for (const [name, rawValue] of entries) {
    const upper = name.toUpperCase();
    if (
      !VM_ENV_NAME_PATTERN.test(name) ||
      VM_ENV_BLOCKED_NAMES.has(upper) ||
      upper.startsWith("LD_") ||
      upper.startsWith("DYLD_") ||
      upper.startsWith("OPENCLAW_") ||
      upper.startsWith("PLATFORMCLAW_") ||
      typeof rawValue !== "string" ||
      Buffer.byteLength(rawValue) > 4096 ||
      rawValue.includes("\u0000") ||
      rawValue.includes("\r") ||
      rawValue.includes("\n")
    ) {
      throw new Error(`VM execution variable is invalid: ${name}`);
    }
    variables[name] = rawValue;
  }
  return { pathPrepend, variables };
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

async function callExecutionHandoff(params: {
  socketPath: string;
  serviceToken: string;
  path: string;
  body: unknown;
}): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify(params.body));
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
        path: params.path,
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

export function parseTarget(
  value: unknown,
  options: { allowMissingCredentialRevision?: boolean } = {},
): PlatformClawExecutionTargetSnapshot {
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
  const credentialRevision = Number(target.credentialRevision ?? 0);
  if (
    !Number.isSafeInteger(credentialRevision) ||
    credentialRevision < (options.allowMissingCredentialRevision ? 0 : 1)
  ) {
    throw new Error("credential revision is invalid");
  }
  const remoteHomeDir = requireAbsoluteRemotePath(target.remoteHomeDir, "remote home");
  const remoteWorkspaceDir = requireAbsoluteRemotePath(
    target.remoteWorkspaceDir,
    "remote workspace",
  );
  if (
    remoteHomeDir !== "/" &&
    remoteWorkspaceDir !== remoteHomeDir &&
    !remoteWorkspaceDir.startsWith(`${remoteHomeDir}/`)
  ) {
    throw new Error("remote workspace is outside the remote home");
  }
  return {
    ...base,
    kind: "assigned_vm",
    allocationId: requireString(target.allocationId, "allocation id"),
    credentialRevision,
    vmLabel: requireString(target.vmLabel, "VM label"),
    safeConnectLabel: requireString(target.safeConnectLabel, "SafeConnect label"),
    endpointHost: requireSshToken(target.endpointHost, "endpoint host"),
    endpointPort: Number(target.endpointPort),
    adDomain: requireSshToken(target.adDomain, "AD domain"),
    adAccount: requireSshToken(target.adAccount, "AD account"),
    targetAddress: requireSshToken(target.targetAddress, "VM address"),
    linuxAccount: requireSshToken(target.linuxAccount, "Linux account"),
    remoteHomeDir,
    remoteWorkspaceDir,
    hostKeyAlgorithm: requireSshToken(target.hostKeyAlgorithm, "host key algorithm"),
    hostKeyPublicKey: requireSshToken(target.hostKeyPublicKey, "host public key"),
    hostKeyFingerprint: requireString(target.hostKeyFingerprint, "host key fingerprint"),
    ...(target.executionEnvironment === undefined
      ? {}
      : { executionEnvironment: parseExecutionEnvironment(target.executionEnvironment) }),
  };
}

function requireAbsoluteRemotePath(value: unknown, label: string): string {
  const raw = requireString(value, label);
  const normalized = path.posix.normalize(raw);
  if (!path.posix.isAbsolute(raw) || normalized !== raw) {
    throw new Error(`${label} is invalid`);
  }
  return raw;
}

function safeConnectConfig(
  target: AssignedVmTargetSnapshot,
  options: { controlPath?: string } = {},
): string {
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
  const multiplexed = Boolean(options.controlPath);
  return [
    "Host platformclaw-safeconnect",
    `  HostName ${endpointHost}`,
    `  Port ${target.endpointPort}`,
    `  User ${user}`,
    `  BatchMode ${multiplexed ? "yes" : "no"}`,
    `  PreferredAuthentications ${multiplexed ? "publickey" : "keyboard-interactive"}`,
    `  KbdInteractiveAuthentication ${multiplexed ? "no" : "yes"}`,
    "  PasswordAuthentication no",
    `  NumberOfPasswordPrompts ${multiplexed ? "0" : "1"}`,
    "  ConnectTimeout 5",
    "  ServerAliveInterval 30",
    "  ServerAliveCountMax 6",
    "  TCPKeepAlive yes",
    "  ControlMaster no",
    `  ControlPath ${options.controlPath ? quoteOpenSshConfigPath(options.controlPath) : "none"}`,
    ...(multiplexed
      ? [
          "  PubkeyAuthentication no",
          "  IdentityFile none",
          "  IdentityAgent none",
          "  IdentitiesOnly yes",
          "  HostbasedAuthentication no",
          "  GSSAPIAuthentication no",
        ]
      : []),
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
  options: { credentialBrokerAddress?: string; credentialGrantToken?: string } = {},
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
          credentialRevision: target.credentialRevision,
          ...(options.credentialGrantToken
            ? {
                credentialBrokerAddress: requireSingleLine(
                  options.credentialBrokerAddress ?? "",
                  "credential broker address",
                ),
                credentialGrantToken: requireSshToken(
                  options.credentialGrantToken,
                  "credential grant",
                ),
              }
            : {}),
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

export async function createMultiplexedSafeConnectSession(
  target: AssignedVmTargetSnapshot,
  controlPath: string,
): Promise<SshSandboxSession> {
  const session = await createSshSandboxSessionFromConfigText({
    configText: safeConnectConfig(target, { controlPath }),
    host: "platformclaw-safeconnect",
    command: "ssh",
  });
  try {
    const sessionDir = path.dirname(session.configPath);
    const knownHostsPath = path.join(sessionDir, "known_hosts");
    const hostPattern =
      target.endpointPort === 22
        ? target.endpointHost
        : `[${target.endpointHost}]:${target.endpointPort}`;
    await writeFile(
      knownHostsPath,
      `${hostPattern} ${requireSshToken(target.hostKeyAlgorithm, "host key algorithm")} ${requireSshToken(target.hostKeyPublicKey, "host public key")}\n`,
      { mode: 0o600 },
    );
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

async function testAssignedVmConnection(params: {
  target: AssignedVmTargetSnapshot;
  credentialBrokerAddress: string;
  credentialGrantToken: string;
  logTiming?: (message: string) => void;
}): Promise<{
  allocationId: string;
  targetRevision: number;
  remoteHomeDir: string;
  remoteWorkspaceDir: string;
}> {
  const startedAt = performance.now();
  let timingStatus = "failed";
  const session = await createSafeConnectSession(
    params.target,
    "/usr/local/bin/platformclaw-sshpass",
    {
      credentialBrokerAddress: params.credentialBrokerAddress,
      credentialGrantToken: params.credentialGrantToken,
    },
  );
  try {
    let result;
    try {
      result = await runSshSandboxCommand({
        session,
        remoteCommand:
          'set -eu; test -n "$HOME"; home=$(cd -- "$HOME" && pwd -P); mkdir -p -- "$home/.platformclaw/workspace"; printf \'%s\\n%s\\n\' "$home" "$(id -un)"',
        signal: AbortSignal.timeout(VM_CONNECTION_TEST_TIMEOUT_MS),
        maxBufferBytes: 4 * 1024,
      });
    } catch (error) {
      // sshpass exit 5 specifically means invalid/expired credentials. Infrastructure,
      // broker, host-key, and transport failures must not invalidate a healthy VM target.
      if (isSshpassAuthenticationFailure(error)) {
        throw new PlatformClawVmAuthenticationError();
      }
      throw error;
    }
    const [remoteHomeDir, remoteUser, ...extra] = result.stdout
      .toString("utf8")
      .trimEnd()
      .split("\n");
    if (
      extra.length > 0 ||
      !remoteHomeDir?.startsWith("/") ||
      remoteHomeDir === "/" ||
      remoteUser !== params.target.linuxAccount
    ) {
      throw new Error("assigned VM identity response is invalid");
    }
    timingStatus = "passed";
    return {
      allocationId: params.target.allocationId,
      targetRevision: params.target.revision,
      remoteHomeDir,
      remoteWorkspaceDir: path.posix.join(remoteHomeDir, ".platformclaw/workspace"),
    };
  } finally {
    await disposeSshSandboxSession(session);
    params.logTiming?.(
      `event=platformclaw_vm_connection_test_timing status=${timingStatus} durationMs=${String(Math.max(0, Math.round(performance.now() - startedAt)))} timeoutMs=${String(VM_CONNECTION_TEST_TIMEOUT_MS)}`,
    );
  }
}

export async function createExecutionDependenciesFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  timing: { logTiming?: (message: string) => void } = {},
): Promise<
  PlatformClawExecutionDependencies &
    PlatformClawSkillExportRuntime & {
      testConnection(params: {
        agentId: string;
        credentialBrokerAddress: string;
        credentialGrantToken: string;
      }): Promise<{
        allocationId: string;
        targetRevision: number;
        remoteHomeDir: string;
        remoteWorkspaceDir: string;
      }>;
      testCandidateConnection(params: {
        target: unknown;
        credentialBrokerAddress: string;
        credentialGrantToken: string;
      }): Promise<{
        allocationId: string;
        targetRevision: number;
        remoteHomeDir: string;
        remoteWorkspaceDir: string;
      }>;
      changeTarget(params: {
        agentId: string;
        target: "platform_server" | "assigned_vm";
        expectedRevision: number;
      }): Promise<PlatformClawExecutionTargetSnapshot>;
      dispose(): Promise<void>;
    }
> {
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
  const sshLeases = new SafeConnectSshLeaseManager({
    createAuthenticatedSession: async (target) => await createSafeConnectSession(target),
    createMultiplexedSession: createMultiplexedSafeConnectSession,
    disposeSession: disposeSshSandboxSession,
    logTiming: timing.logTiming,
  });
  // Runtime is the composition root: remote discovery must not import it back.
  const remoteSkills = new VmRemoteSkillCatalogService(
    {
      createSession: async (target) => await sshLeases.createSession(target),
      disposeSession: disposeSshSandboxSession,
      runCommand: runSshSandboxCommand,
    },
    {
      logTiming: timing.logTiming,
    },
  );
  const remoteSkillWorkshop = new VmRemoteSkillWorkshopService({
    createSession: async (target) => await sshLeases.createSession(target),
    disposeSession: disposeSshSandboxSession,
    runCommand: runSshSandboxCommand,
  });
  const remoteSkillInstaller = new VmRemoteSkillInstallerService({
    createSession: async (target) => await sshLeases.createSession(target),
    disposeSession: disposeSshSandboxSession,
    runCommand: runSshSandboxCommand,
    uploadDirectory: uploadDirectoryToSshTarget,
  });
  const remoteSkillExporter = new VmRemoteSkillExportService({
    createSession: async (target) => await sshLeases.createSession(target),
    disposeSession: disposeSshSandboxSession,
  });
  const resolveTarget: PlatformClawExecutionDependencies["resolveTarget"] = async ({
    agentId,
    target: requestedTarget,
  }) => {
    const target = parseTarget(
      await callExecutionHandoff({
        socketPath: executionHandoffAddress(brokerAddress),
        serviceToken,
        path: EXECUTION_TARGET_PATH,
        body: { agentId, ...(requestedTarget ? { target: requestedTarget } : {}) },
      }),
    );
    sshLeases.observeTarget(agentId, target.kind === "assigned_vm" ? target : undefined);
    return target;
  };
  return {
    resolveExecCredentials: async (agentId) => {
      const value = await callExecutionHandoff({
        socketPath: executionHandoffAddress(brokerAddress),
        serviceToken,
        path: EXECUTION_CREDENTIALS_PATH,
        body: { agentId },
      });
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !Object.values(value).every((entry) => typeof entry === "string")
      ) {
        throw new Error("execution handoff returned invalid exec credentials");
      }
      return value as Record<string, string>;
    },
    resolveTarget,
    createPlatformServerHandle: async ({ createParams }) =>
      await requireSandboxBackendFactory("docker")(createParams),
    createAssignedVmHandle: async ({ createParams, target }) =>
      await createSshSandboxBackendWithSessionFactory(createParams, {
        targetLabel: `${target.endpointHost}:${target.endpointPort}`,
        workspaceRoot: target.remoteWorkspaceDir,
        workspaceMode: "existing",
        remoteHomeDir: target.remoteHomeDir,
        additionalFilesystemRoots: [{ root: target.remoteHomeDir, access: "rw" }],
        createSession: async () => await sshLeases.createSession(target),
      }),
    listTargetSkills: async ({ refresh, target }) =>
      target.kind === "assigned_vm" ? await remoteSkills.list(target, refresh) : undefined,
    createSkillWorkshopTarget: async ({ target, catalog }) =>
      target.kind === "assigned_vm"
        ? remoteSkillWorkshop.createAccess({
            target,
            ...(catalog ? { catalog } : {}),
            refreshCatalog: async () => await remoteSkills.list(target, true),
          })
        : undefined,
    createSkillInstallTarget: async ({ target }) =>
      target.kind === "assigned_vm"
        ? remoteSkillInstaller.createAccess({
            target,
            refreshCatalog: async () => await remoteSkills.list(target, true),
          })
        : undefined,
    createTerminalProcess: async (target) => {
      const session = await sshLeases.createSession(target);
      const argv = buildSshLoginShellArgv(session);
      return {
        file: argv[0]!,
        args: argv.slice(1),
        cwd: process.cwd(),
        dispose: async () => await disposeSshSandboxSession(session),
      };
    },
    testConnection: async ({ agentId, credentialBrokerAddress, credentialGrantToken }) => {
      // This endpoint consumes the probe-only connection snapshot. It discovers
      // canonical HOME before any executable backend snapshot can be created.
      const target = parseTarget(
        await callExecutionHandoff({
          socketPath: executionHandoffAddress(brokerAddress),
          serviceToken,
          path: EXECUTION_CONNECTION_TARGET_PATH,
          body: { agentId },
        }),
        { allowMissingCredentialRevision: true },
      );
      if (target.kind !== "assigned_vm") {
        throw new Error("assigned VM connection target is unavailable");
      }
      return await testAssignedVmConnection({
        target,
        credentialBrokerAddress,
        credentialGrantToken,
        logTiming: timing.logTiming,
      });
    },
    testCandidateConnection: async ({
      target: rawTarget,
      credentialBrokerAddress,
      credentialGrantToken,
    }) => {
      const target = parseTarget(rawTarget, { allowMissingCredentialRevision: true });
      if (target.kind !== "assigned_vm") {
        throw new Error("development VM candidate is invalid");
      }
      return await testAssignedVmConnection({
        target,
        credentialBrokerAddress,
        credentialGrantToken,
        logTiming: timing.logTiming,
      });
    },
    changeTarget: async ({ agentId, target, expectedRevision }) => {
      const changed = parseTarget(
        await callExecutionHandoff({
          socketPath: executionHandoffAddress(brokerAddress),
          serviceToken,
          path: EXECUTION_CHANGE_TARGET_PATH,
          body: { agentId, target, expectedRevision },
        }),
      );
      sshLeases.observeTarget(agentId, changed.kind === "assigned_vm" ? changed : undefined);
      return changed;
    },
    exportWorkspaceSkill: async ({
      agentId,
      slug,
      version,
      expectedTargetRevision,
      expectedAllocationId,
      signal,
    }) => {
      const target = await resolveTarget({ agentId, target: "assigned_vm" });
      if (
        target.kind !== "assigned_vm" ||
        target.revision !== expectedTargetRevision ||
        target.allocationId !== expectedAllocationId
      ) {
        throw new Error("My VM work location changed; reload and retry publishing");
      }
      return await remoteSkillExporter.export({ target, slug, version, signal });
    },
    dispose: async () => await sshLeases.dispose(),
  };
}
