import { describe, expect, it } from "vitest";
import { buildAssignedVmAcpRemoteCommand } from "./acp-process-command.js";
import type { AssignedVmTargetSnapshot } from "./backend.js";

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
  it("uses only the root-managed Claude adapter and typed per-user executable", () => {
    const command = buildAssignedVmAcpRemoteCommand(
      {
        executionOwnerAgentId: "person_one",
        agent: "claude",
        sessionKey: "session-one",
        command: "/tmp/attacker-adapter",
        args: ["--attacker"],
        cwd: "/tmp/attacker-workdir",
        env: { LD_PRELOAD: "/tmp/attacker.so" },
      },
      TARGET,
    );

    expect(command).toContain("/opt/platformclaw/libexec/claude-agent-acp/bin/claude-agent-acp");
    expect(command).toContain("CLAUDE_CODE_EXECUTABLE");
    expect(command).toContain("/home/person.one/.local/bin/claude");
    expect(command).toContain("/home/person.one/workspace");
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
    expect(command).toContain("'acp'");
    expect(() =>
      buildAssignedVmAcpRemoteCommand(
        {
          executionOwnerAgentId: "person_one",
          agent: "codex",
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
});
