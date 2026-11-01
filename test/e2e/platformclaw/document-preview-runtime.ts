import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SandboxBackendHandle,
  SandboxFsBridgeContext,
} from "../../../src/agents/sandbox/backend-handle.types.js";
import { resolveSandboxConfigForAgent } from "../../../src/agents/sandbox/config.js";
import {
  createDockerSandboxBackend,
  dockerSandboxBackendManager,
} from "../../../src/agents/sandbox/docker-backend.js";
import { createSandboxFsBridge } from "../../../src/agents/sandbox/fs-bridge.js";
import type { SandboxOutboundFileAccess } from "../../../src/agents/sandbox/fs-bridge.types.js";
import { createSandboxOutboundFileAccess } from "../../../src/agents/sandbox/outbound-file-access.js";
import { removeRegistryEntry } from "../../../src/agents/sandbox/registry.js";
import { createSshSandboxBackendWithSessionFactory } from "../../../src/agents/sandbox/ssh-backend.js";
import {
  createSshSandboxSessionFromConfigText,
  shellEscape,
} from "../../../src/agents/sandbox/ssh.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";

type DocumentPreviewSshFixture = {
  host: string;
  port: number;
  /** Complete public-key line from the task-owned fixture's host-key metadata. */
  publicKey: string;
  password: string;
};

export type DocumentPreviewExecutionRuntime = {
  transport: "docker" | "ssh";
  workspacePath: string;
  outboundFileAccess: SandboxOutboundFileAccess;
  write(filename: string, bytes: Buffer): Promise<string>;
  remove(filename: string): Promise<void>;
  revoke(): void;
  cleanup(): Promise<void>;
};

/** Explicit Docker E2E only; the caller supplies its isolated OPENCLAW_STATE_DIR. */
export async function createDocumentPreviewRuntime(params: {
  target: "platform_server" | "assigned_vm";
  workspaceDir: string;
  scopeKey: string;
  sandboxImage: string;
  sshFixture?: DocumentPreviewSshFixture;
}): Promise<DocumentPreviewExecutionRuntime> {
  const localRoot = await mkdtemp(path.join(os.tmpdir(), "pc-document-runtime-"));
  const localWorkspace = path.join(localRoot, "workspace");
  await mkdir(localWorkspace);
  const remoteHome = "/users/person_one";
  const remoteWorkspace = `${remoteHome}/.platformclaw/preview-${randomUUID()}`;
  const remoteOwnedPaths = [remoteWorkspace];
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope: "session",
          workspaceAccess: "rw",
          docker: {
            image: params.sandboxImage,
            containerPrefix: "pc-document-preview-",
            workdir: "/workspace",
            user: "0:0",
            network: "none",
          },
        },
      },
    },
  };
  const cfg = resolveSandboxConfigForAgent(config);
  const createdAtMs = Date.now();
  const createParams = {
    sessionKey: params.scopeKey,
    scopeKey: `${params.scopeKey}:${randomUUID()}`,
    workspaceDir: localWorkspace,
    agentWorkspaceDir: params.workspaceDir,
    cfg,
  };
  let backend: SandboxBackendHandle | undefined;
  let runtimeReady = false;
  let current = true;
  const assertCurrentAuthority = async () => {
    if (!current) {
      throw new Error("Document preview execution target was revoked");
    }
  };
  const cleanup = async () => {
    current = false;
    try {
      if (!backend) {
        return;
      }
      if (params.target === "platform_server") {
        await dockerSandboxBackendManager.removeRuntime({
          config,
          entry: {
            containerName: backend.runtimeId,
            sessionKey: createParams.sessionKey,
            createdAtMs,
            lastUsedAtMs: createdAtMs,
            image: params.sandboxImage,
          },
        });
        await removeRegistryEntry(backend.runtimeId);
      } else if (runtimeReady) {
        await backend.runShellCommand({
          script: 'set -eu\nfor target in "$@"; do rm -rf -- "$target"; done',
          args: remoteOwnedPaths,
        });
      }
      backend = undefined;
    } finally {
      await rm(localRoot, { recursive: true, force: true });
    }
  };
  try {
    if (params.target === "platform_server") {
      backend = await createDockerSandboxBackend(createParams);
    } else {
      const fixture = params.sshFixture;
      if (!fixture) {
        throw new Error("Assigned-VM document proof requires the task-owned SSH fixture");
      }
      if (
        !/^[A-Za-z0-9_.-]+$/u.test(fixture.host) ||
        !Number.isInteger(fixture.port) ||
        fixture.port < 1 ||
        fixture.port > 65535 ||
        !/^ssh-ed25519 [A-Za-z0-9+/=]+$/u.test(fixture.publicKey.trim())
      ) {
        throw new Error("Invalid task-owned SSH fixture endpoint or host key");
      }
      const passwordFile = path.join(localRoot, "fixture-password");
      const command = path.join(localRoot, "fixture-ssh");
      const knownHosts = path.join(localRoot, "known-hosts");
      await writeFile(passwordFile, fixture.password, { mode: 0o600 });
      await writeFile(
        knownHosts,
        `[${fixture.host}]:${fixture.port} ${fixture.publicKey.trim()}\n`,
        { mode: 0o600 },
      );
      await writeFile(
        command,
        `#!/bin/sh\nexec sshpass -f ${shellEscape(passwordFile)} ssh "$@"\n`,
        { mode: 0o700 },
      );
      await chmod(command, 0o700);
      const configText =
        [
          "Host document-preview-fixture",
          `  HostName ${fixture.host}`,
          `  Port ${fixture.port}`,
          "  User samsungds.net\\person.one+person_one+10.0.0.10",
          "  BatchMode no",
          "  PreferredAuthentications keyboard-interactive",
          "  KbdInteractiveAuthentication yes",
          "  PasswordAuthentication no",
          "  NumberOfPasswordPrompts 1",
          "  IdentityAgent none",
          "  IdentityFile none",
          "  PubkeyAuthentication no",
          "  StrictHostKeyChecking yes",
          `  UserKnownHostsFile ${knownHosts}`,
          "  GlobalKnownHostsFile /dev/null",
          "  ConnectTimeout 5",
        ].join("\n") + "\n";
      backend = await createSshSandboxBackendWithSessionFactory(createParams, {
        targetLabel: "document-preview-fixture",
        workspaceRoot: remoteWorkspace,
        workspaceMode: "existing",
        remoteHomeDir: remoteHome,
        additionalFilesystemRoots: [{ root: remoteHome, access: "rw" }],
        createSession: async () => createSshSandboxSessionFromConfigText({ configText, command }),
      });
    }
    const runtime = backend;
    const sandbox: SandboxFsBridgeContext = {
      workspaceDir: localWorkspace,
      agentWorkspaceDir: params.workspaceDir,
      workspaceAccess: "rw",
      containerName: runtime.runtimeId,
      containerWorkdir: runtime.workdir,
      docker: {},
      backend: runtime,
    };
    const bridge = runtime.createFsBridge?.({ sandbox }) ?? createSandboxFsBridge({ sandbox });
    const outboundFileAccess = await createSandboxOutboundFileAccess({
      backend: { ...runtime, assertCurrentAuthority },
      bridge,
      scopeKey: createParams.scopeKey,
      workspaceDir: localWorkspace,
      workspaceOnly: true,
    });
    if (params.target === "assigned_vm") {
      remoteOwnedPaths.push(outboundFileAccess.tempDir);
    }
    runtimeReady = true;
    const sourcePath = (filename: string) => {
      if (
        !filename ||
        filename === "." ||
        filename === ".." ||
        path.posix.basename(filename) !== filename ||
        filename.includes("\\") ||
        /[\0\r\n]/u.test(filename)
      ) {
        throw new Error("Document fixture name must be one filename");
      }
      return path.posix.join(runtime.workdir, filename);
    };
    return {
      transport: params.target === "platform_server" ? "docker" : "ssh",
      workspacePath: runtime.workdir,
      outboundFileAccess,
      async write(filename, bytes) {
        await assertCurrentAuthority();
        const filePath = sourcePath(filename);
        await runtime.runShellCommand({
          script: 'set -eu\ncat > "$1"',
          args: [filePath],
          stdin: bytes,
        });
        return filePath;
      },
      async remove(filename) {
        await runtime.runShellCommand({
          script: 'set -eu\nrm -- "$1"',
          args: [sourcePath(filename)],
        });
      },
      revoke() {
        current = false;
      },
      cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Document runtime setup and cleanup failed");
    }
    throw error;
  }
}
