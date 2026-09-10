import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAssignedVmAcpDiagnosticCommand,
  buildAssignedVmAcpRemoteCommand,
  PLATFORMCLAW_VM_ACP_AGENTS,
} from "./acp-process-command.js";
import {
  diagnoseAssignedVmAcpProcess,
  launchAssignedVmAcpProcess,
} from "./acp-process-transport.js";
import type { AssignedVmTargetSnapshot } from "./backend.js";

const { runSshSandboxCommandMock, disposeSshSandboxSessionMock } = vi.hoisted(() => ({
  runSshSandboxCommandMock: vi.fn(),
  disposeSshSandboxSessionMock: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/sandbox")>()),
  disposeSshSandboxSession: disposeSshSandboxSessionMock,
  runSshSandboxCommand: runSshSandboxCommandMock,
}));

const TARGET: AssignedVmTargetSnapshot = {
  kind: "assigned_vm",
  agentId: "person_one",
  targetId: "vm-one",
  revision: 9,
  allocationId: "allocation-one",
  credentialRevision: 3,
  vmLabel: "Development VM",
  safeConnectLabel: "Corporate access",
  remoteHomeDir: "/home/person.one",
  remoteWorkspaceDir: "/home/person.one/workspace",
  endpointHost: "safeconnect.example",
  endpointPort: 44422,
  adDomain: "example.com",
  adAccount: "person.one",
  targetAddress: "192.0.2.10",
  linuxAccount: "person.one",
  hostKeyAlgorithm: "ssh-ed25519",
  hostKeyPublicKey: "AAAA-approved-key",
  hostKeyFingerprint: "SHA256:approved",
  claudeCodeExecutablePath: "/home/person.one/.local/bin/claude",
};

describe("assigned VM ACP process transport", () => {
  beforeEach(() => {
    runSshSandboxCommandMock.mockReset();
    disposeSshSandboxSessionMock.mockClear();
  });

  it.each([
    ["claude", "/opt/platformclaw/libexec/claude-agent-acp/bin/claude-agent-acp"],
    ["codex", "/opt/platformclaw/libexec/codex-acp/bin/codex-acp"],
    ["opencode", "/opt/platformclaw/libexec/opencode-acp/bin/opencode"],
  ])("launches %s only in the assigned employee account", (agent, executable) => {
    const command = buildAssignedVmAcpRemoteCommand(
      {
        executionOwnerAgentId: "person_one",
        agent: ` ${agent.toUpperCase()} `,
        sessionKey: "session-one",
        command: "/tmp/attacker-adapter",
        args: ["--attacker"],
        cwd: "/tmp/attacker-workdir",
        env: { LD_PRELOAD: "/tmp/attacker.so", CODEX_HOME: "/tmp/attacker-home" },
      },
      TARGET,
    );

    expect(PLATFORMCLAW_VM_ACP_AGENTS.has(agent)).toBe(true);
    expect(command).toContain(executable);
    expect(command).toContain("CLAUDE_CODE_EXECUTABLE");
    expect(command).toContain("/home/person.one/.local/bin/claude");
    expect(command).toContain("/home/person.one/workspace");
    expect(command).toContain("HOME");
    expect(command).toContain("/home/person.one");
    expect(command).not.toContain("attacker");
    expect(command).not.toContain("LD_PRELOAD");
  });

  it("uses the pinned OpenCode adapter contract", () => {
    const command = buildAssignedVmAcpRemoteCommand(
      {
        executionOwnerAgentId: "person_one",
        agent: "opencode",
        sessionKey: "session-one",
        command: "ignored",
        args: [],
        cwd: "/ignored",
        env: {},
      },
      TARGET,
    );
    expect(command).toContain("/opt/platformclaw/libexec/opencode-acp/bin/opencode");
    expect(command).toContain('exec "$adapter" acp');
    expect(() =>
      buildAssignedVmAcpRemoteCommand(
        {
          executionOwnerAgentId: "person_one",
          agent: "unsupported-agent",
          sessionKey: "session-one",
          command: "ignored",
          args: [],
          cwd: "/ignored",
          env: {},
        },
        TARGET,
      ),
    ).toThrow("unsupported");
  });

  it.each(["claude", "codex", "opencode"])(
    "builds a bounded %s diagnostic without logical launcher input",
    (agent) => {
      const command = buildAssignedVmAcpDiagnosticCommand(agent, TARGET);
      expect(command).toContain("platformclaw-acp-check");
      expect(command).toContain("Assigned VM ACP adapter is not installed");
      expect(command).not.toContain("attacker");
    },
  );

  it("returns fixed adapter diagnostics without exposing remote stderr", async () => {
    const sentinel = "secret-host.example token=sentinel-secret";
    runSshSandboxCommandMock.mockRejectedValueOnce(
      Object.assign(new Error(sentinel), { code: 120, stderr: Buffer.from(sentinel) }),
    );

    const report = await diagnoseAssignedVmAcpProcess({
      agent: "claude",
      target: { ...TARGET, endpointHost: sentinel },
      createSession: vi.fn(async () => ({
        command: "ssh",
        configPath: "/tmp/platformclaw-test/config",
        host: sentinel,
      })),
    });

    expect(report).toEqual({
      ok: false,
      stage: "adapter",
      code: "adapter_missing",
      message:
        "Assigned VM ACP adapter is not installed. Install the PlatformClaw VM ACP adapter bundle.",
    });
    expect(JSON.stringify(report)).not.toContain("sentinel-secret");
    expect(disposeSshSandboxSessionMock).toHaveBeenCalledOnce();
  });

  it("fails launch at adapter preflight without falling back or exposing remote stderr", async () => {
    const sentinel = "secret-host.example token=sentinel-secret";
    runSshSandboxCommandMock.mockRejectedValueOnce(
      Object.assign(new Error(sentinel), { code: 120, stderr: Buffer.from(sentinel) }),
    );

    await expect(
      launchAssignedVmAcpProcess({
        input: {
          executionOwnerAgentId: "person_one",
          agent: "claude",
          sessionKey: "session-one",
          command: "ignored",
          args: [],
          cwd: "/ignored",
          env: {},
        },
        target: TARGET,
        createSession: vi.fn(async () => ({
          command: "ssh",
          configPath: "/tmp/platformclaw-test/config",
          host: sentinel,
        })),
      }),
    ).rejects.toMatchObject({
      stage: "adapter",
      code: "adapter_missing",
      message:
        "Assigned VM ACP adapter is not installed. Install the PlatformClaw VM ACP adapter bundle.",
    });
    expect(disposeSshSandboxSessionMock).toHaveBeenCalledOnce();
  });

  it("bounds diagnostic timeout and always releases the SSH session", async () => {
    runSshSandboxCommandMock.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
      expect(signal).toBeDefined();
      throw Object.assign(new Error("operation timed out"), { name: "AbortError" });
    });

    await expect(
      diagnoseAssignedVmAcpProcess({
        agent: "opencode",
        target: TARGET,
        createSession: vi.fn(async () => ({
          command: "ssh",
          configPath: "/tmp/platformclaw-test/config",
          host: "safeconnect.example",
        })),
      }),
    ).resolves.toMatchObject({ ok: false, stage: "ssh", code: "vm_connection_timeout" });
    expect(disposeSshSandboxSessionMock).toHaveBeenCalledOnce();
  });
});
