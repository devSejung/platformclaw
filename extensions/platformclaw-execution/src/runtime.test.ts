import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { disposeSshSandboxSession, type SshSandboxSession } from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it, vi } from "vitest";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import {
  createMultiplexedSafeConnectSession,
  createExecutionDependenciesFromEnvironment,
  createSafeConnectSession,
  parseTarget,
  quoteOpenSshConfigPath,
} from "./runtime.js";
import {
  PlatformClawTargetChangeError,
  PlatformClawTargetMutationCoordinator,
} from "./target-mutation-coordinator.js";
import { VmTmuxTerminalManager } from "./tmux-terminal-manager.js";

const leaseIo = vi.hoisted(() => ({
  manager: undefined as import("./ssh-lease-manager.js").SafeConnectSshLeaseManager | undefined,
  startMaster: vi.fn(async () => {
    let running = true;
    return {
      isRunning: () => running,
      onExit: () => undefined,
      stop: vi.fn(async () => {
        running = false;
      }),
    };
  }),
}));

vi.mock("./ssh-lease-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssh-lease-manager.js")>();
  return {
    ...actual,
    SafeConnectSshLeaseManager: class extends actual.SafeConnectSshLeaseManager {
      constructor(options: ConstructorParameters<typeof actual.SafeConnectSshLeaseManager>[0]) {
        super({ ...options, startMaster: leaseIo.startMaster });
        leaseIo.manager = this;
      }
    },
  };
});

const TARGET: AssignedVmTargetSnapshot = {
  kind: "assigned_vm",
  agentId: "person_one",
  targetId: "vm-one",
  revision: 9,
  allocationId: "allocation-one",
  credentialRevision: 3,
  vmLabel: "Development VM",
  safeConnectLabel: "Corporate access",
  remoteHomeDir: "/users/person.one",
  remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
  endpointHost: "safeconnect.example",
  endpointPort: 44422,
  adDomain: "example.com",
  adAccount: "person.one",
  targetAddress: "192.0.2.10",
  linuxAccount: "person.one",
  hostKeyAlgorithm: "ssh-ed25519",
  hostKeyPublicKey: "AAAA-approved-key",
  hostKeyFingerprint: "SHA256:approved",
  codingAgents: [
    {
      agent: "claude",
      enabled: false,
      executablePath: "",
      environment: {
        ANTHROPIC_BASE_URL: "",
        ADMIN_API_URL: "",
        OIDC_ISSUER_URL: "",
        OIDC_CLIENT_ID: "",
      },
    },
    { agent: "codex", enabled: false, executablePath: "" },
    { agent: "opencode", enabled: false, executablePath: "" },
  ],
};

describe("PlatformClaw SafeConnect session", () => {
  it.each([
    { destination: "platform_server", lostResponse: false },
    { destination: "assigned_vm", lostResponse: false },
    { destination: "platform_server", lostResponse: true },
    { destination: "assigned_vm", lostResponse: true },
  ] as const)(
    "preserves failed selection and retires committed authority: $destination lostResponse=$lostResponse",
    async ({ destination, lostResponse }) => {
      leaseIo.startMaster.mockClear();
      const directory = await mkdtemp(path.join(tmpdir(), "platformclaw-runtime-target-"));
      const tokenFile = path.join(directory, "execution-token");
      await writeFile(tokenFile, "test-runtime-token");
      const brokerAddress =
        process.platform === "win32"
          ? String.raw`\\.\pipe\platformclaw-target-${randomUUID()}`
          : path.join(directory, "broker.sock");
      const socketPath =
        process.platform === "win32"
          ? `${brokerAddress}-execution`
          : path.join(directory, "execution.sock");
      const basic = {
        kind: "platform_server",
        agentId: TARGET.agentId,
        targetId: "platform-server",
        revision: TARGET.revision,
      };
      const changed =
        destination === "platform_server"
          ? { ...basic, revision: TARGET.revision + 1 }
          : {
              ...TARGET,
              targetId: "vm-two",
              allocationId: "allocation-two",
              targetAddress: "192.0.2.11",
              revision: TARGET.revision + 1,
            };
      let rejectChange = true;
      let committed = false;
      let active = "platform_server";
      const requests: Array<{
        agentId: string;
        target?: string;
        connectionId?: string;
        expectedConnectionRevision?: number;
      }> = [];
      const server = createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.from(chunk));
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            agentId: string;
            target?: string;
            connectionId?: string;
            expectedConnectionRevision?: number;
          };
          requests.push(body);
          res.setHeader("Content-Type", "application/json");
          if (req.url?.endsWith("/change-target")) {
            if (rejectChange) {
              res.statusCode = 409;
              res.end(JSON.stringify({ error: "target changed" }));
              return;
            }
            active = body.target!;
            committed = true;
            if (lostResponse) {
              res.statusCode = 503;
              res.end(JSON.stringify({ error: "response lost after commit" }));
              return;
            }
            res.end(JSON.stringify(changed));
            return;
          }
          res.end(
            JSON.stringify(
              committed ? changed : (body.target ?? active) === "assigned_vm" ? TARGET : basic,
            ),
          );
        })().catch((error: unknown) => {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      });
      const terminalTarget = vi.spyOn(VmTmuxTerminalManager.prototype, "observeTarget");
      const channels: SshSandboxSession[] = [];
      let dependencies:
        | Awaited<ReturnType<typeof createExecutionDependenciesFromEnvironment>>
        | undefined;
      try {
        await new Promise<void>((resolve) => {
          server.listen(socketPath, resolve);
        });
        dependencies = await createExecutionDependenciesFromEnvironment(
          {
            PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS: brokerAddress,
            PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE: tokenFile,
          },
          { targetMutations: new PlatformClawTargetMutationCoordinator() },
        );
        await expect(dependencies.resolveTarget({ agentId: TARGET.agentId })).resolves.toEqual(
          basic,
        );
        await expect(
          dependencies.resolveTarget({ agentId: TARGET.agentId, target: "platform_server" }),
        ).resolves.toEqual(basic);
        await expect(
          dependencies.resolveTarget({ agentId: TARGET.agentId, target: "assigned_vm" }),
        ).resolves.toMatchObject(TARGET);
        expect(terminalTarget).toHaveBeenCalledExactlyOnceWith(TARGET.agentId, undefined);
        const manager = leaseIo.manager!;
        channels.push(await manager.createSession(TARGET));
        const master = await leaseIo.startMaster.mock.results[0]!.value;
        await expect(
          dependencies.resolveTarget({ agentId: TARGET.agentId, target: "assigned_vm" }),
        ).resolves.toMatchObject(TARGET);
        expect(terminalTarget).toHaveBeenCalledTimes(1);
        await expect(dependencies.resolveTarget({ agentId: TARGET.agentId })).resolves.toEqual(
          basic,
        );
        expect(terminalTarget).toHaveBeenLastCalledWith(TARGET.agentId, undefined);
        channels.push(await manager.createSession(TARGET));
        expect(leaseIo.startMaster).toHaveBeenCalledTimes(1);
        expect(master.isRunning()).toBe(true);
        expect(master.stop).not.toHaveBeenCalled();
        const selection = {
          agentId: TARGET.agentId,
          target: destination,
          expectedRevision: TARGET.revision,
          ...(destination === "assigned_vm"
            ? { connectionId: "connection-two", expectedConnectionRevision: 3 }
            : {}),
        };
        const observedBeforeFailure = terminalTarget.mock.calls.length;
        await expect(dependencies.changeTarget(selection)).rejects.toThrow("(409)");
        expect(master.isRunning()).toBe(true);
        expect(master.stop).not.toHaveBeenCalled();
        expect(terminalTarget).toHaveBeenCalledTimes(observedBeforeFailure);
        rejectChange = false;
        if (lostResponse) {
          await expect(dependencies.changeTarget(selection)).rejects.toBeInstanceOf(
            PlatformClawTargetChangeError,
          );
        } else {
          await expect(dependencies.changeTarget(selection)).resolves.toEqual(changed);
        }
        await vi.waitFor(() => expect(master.stop).toHaveBeenCalledOnce());
        expect(master.isRunning()).toBe(false);
        expect(terminalTarget).toHaveBeenLastCalledWith(
          TARGET.agentId,
          destination === "assigned_vm" ? changed : undefined,
        );
        expect(requests.findLast((request) => request.target === destination)).toEqual(selection);
        expect(requests.map((request) => request.target)).toEqual([
          undefined,
          "platform_server",
          "assigned_vm",
          "assigned_vm",
          undefined,
          destination,
          undefined,
          destination,
          ...(lostResponse ? [undefined] : []),
        ]);
      } finally {
        await Promise.all(channels.map((channel) => disposeSshSandboxSession(channel)));
        await dependencies?.dispose();
        terminalTarget.mockRestore();
        leaseIo.manager = undefined;
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("requires the assigned VM workspace to stay inside its canonical home", () => {
    expect(parseTarget(TARGET)).toMatchObject({
      remoteHomeDir: "/users/person.one",
      remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
    });
    expect(() => parseTarget({ ...TARGET, remoteWorkspaceDir: "/srv/shared/workspace" })).toThrow(
      "outside the remote home",
    );
    expect(() => parseTarget({ ...TARGET, remoteHomeDir: "/users/person.one/../other" })).toThrow(
      "remote home is invalid",
    );
    expect(() => parseTarget({ ...TARGET, credentialRevision: undefined })).toThrow(
      "credential revision is invalid",
    );
  });

  it("accepts bounded VM build environment and rejects launcher injection", () => {
    expect(
      parseTarget({
        ...TARGET,
        executionEnvironment: {
          pathPrepend: ["/opt/clang/bin"],
          variables: { TOOLCHAIN_PREFIX: "/opt/gcc/bin/aarch64-elf-" },
        },
      }),
    ).toMatchObject({
      executionEnvironment: {
        pathPrepend: ["/opt/clang/bin"],
        variables: { TOOLCHAIN_PREFIX: "/opt/gcc/bin/aarch64-elf-" },
      },
    });
    expect(() =>
      parseTarget({
        ...TARGET,
        executionEnvironment: { pathPrepend: [], variables: { LD_PRELOAD: "/tmp/bad.so" } },
      }),
    ).toThrow("LD_PRELOAD");
  });

  it("requires one canonical configuration for each coding agent", () => {
    expect(parseTarget(TARGET)).toMatchObject({ codingAgents: TARGET.codingAgents });
    expect(() => parseTarget({ ...TARGET, codingAgents: TARGET.codingAgents.slice(0, 2) })).toThrow(
      "incomplete",
    );
  });

  it("quotes whitespace and OpenSSH percent tokens in generated paths", () => {
    expect(quoteOpenSshConfigPath("/tmp/Person One/100%/known_hosts")).toBe(
      '"/tmp/Person One/100%%/known_hosts"',
    );
    expect(quoteOpenSshConfigPath(String.raw`C:\Users\Person One\known_hosts`)).toBe(
      String.raw`"C:\\Users\\Person One\\known_hosts"`,
    );
  });

  it("pins the approved endpoint key and stores no password", async () => {
    const session = await createSafeConnectSession(TARGET, "platformclaw-sshpass-test");
    try {
      const dir = path.dirname(session.configPath);
      const knownHostsPath = path.join(dir, "known_hosts");
      const [config, knownHosts, context] = await Promise.all([
        readFile(session.configPath, "utf8"),
        readFile(knownHostsPath, "utf8"),
        readFile(path.join(dir, "platformclaw-context.json"), "utf8"),
      ]);
      expect(session.command).toBe("platformclaw-sshpass-test");
      expect(config).toContain("PreferredAuthentications keyboard-interactive");
      expect(config).toContain("StrictHostKeyChecking yes");
      expect(config).toContain(`UserKnownHostsFile "${knownHostsPath.replaceAll("\\", "\\\\")}"`);
      expect(config).toContain("User example.com\\person.one+person.one+192.0.2.10");
      expect(knownHosts).toBe("[safeconnect.example]:44422 ssh-ed25519 AAAA-approved-key\n");
      expect(JSON.parse(context)).toEqual({
        agentId: "person_one",
        allocationId: "allocation-one",
        targetRevision: 9,
        credentialRevision: 3,
      });
      expect(context).not.toContain("password");
      expect(context).not.toContain("token");
    } finally {
      await disposeSshSandboxSession(session);
    }
  });

  it("rejects SSH config injection before opening a session", async () => {
    await expect(
      createSafeConnectSession({
        ...TARGET,
        endpointHost: "safeconnect.example ProxyCommand=bad",
      }),
    ).rejects.toThrow("endpoint host is invalid");
  });

  it("reuses only the pinned control socket and disables direct authentication fallback", async () => {
    const session = await createMultiplexedSafeConnectSession(TARGET, "/tmp/master/control.sock");
    try {
      const config = await readFile(session.configPath, "utf8");
      expect(session.command).toBe("ssh");
      expect(config).toContain('ControlPath "/tmp/master/control.sock"');
      expect(config).toContain("BatchMode yes");
      expect(config).toContain("KbdInteractiveAuthentication no");
      expect(config).toContain("PasswordAuthentication no");
      expect(config).toContain("PubkeyAuthentication no");
      expect(config).toContain("IdentityFile none");
      await expect(
        access(path.join(path.dirname(session.configPath), "platformclaw-context.json")),
      ).rejects.toThrow();
    } finally {
      await disposeSshSandboxSession(session);
    }
  });

  it("passes only an anonymous one-shot grant to a connection-test launcher", async () => {
    const session = await createSafeConnectSession(TARGET, "platformclaw-sshpass-test", {
      credentialBrokerAddress: "/run/platformclaw-credential-broker/runtime.sock",
      credentialGrantToken: "grant_token_123456789012345678901234567890",
    });
    try {
      const context = JSON.parse(
        await readFile(
          path.join(path.dirname(session.configPath), "platformclaw-context.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(context).toMatchObject({
        agentId: "person_one",
        credentialBrokerAddress: "/run/platformclaw-credential-broker/runtime.sock",
        credentialGrantToken: "grant_token_123456789012345678901234567890",
      });
      expect(JSON.stringify(context)).not.toContain("password");
    } finally {
      await disposeSshSandboxSession(session);
    }
  });
});
