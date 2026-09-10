import { disposeSshSandboxSession, runSshSandboxCommand } from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import { validateAssignedVmCodingAgent } from "./coding-agent-validation.js";

vi.mock("openclaw/plugin-sdk/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/sandbox")>()),
  disposeSshSandboxSession: vi.fn(),
  runSshSandboxCommand: vi.fn(),
}));

const target: AssignedVmTargetSnapshot = {
  kind: "assigned_vm",
  agentId: "person_one",
  targetId: "vm-one",
  allocationId: "allocation-one",
  revision: 2,
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
  executionEnvironment: {
    pathPrepend: ["/opt/company/bin"],
    variables: { COMPANY_MODE: "enabled" },
  },
};

describe("coding agent installation check", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["codex", "opencode"] as const)(
    "checks managed %s with the assigned execution environment",
    async (agent) => {
      const session = {} as never;
      vi.mocked(runSshSandboxCommand).mockResolvedValue({
        stdout: Buffer.from("1.0.0\n"),
        stderr: Buffer.alloc(0),
        code: 0,
      } as never);
      await expect(
        validateAssignedVmCodingAgent({ target, agent, createSession: async () => session }),
      ).resolves.toEqual({
        agent,
        allocationId: "allocation-one",
        targetRevision: 2,
        reportedVersion: "1.0.0",
      });
      const command = vi.mocked(runSshSandboxCommand).mock.calls[0]![0];
      expect(command.remoteCommand).toContain(
        `/opt/platformclaw/libexec/${agent}-acp/bin/${agent === "codex" ? "codex-acp" : "opencode"}`,
      );
      expect(command.remoteCommand).toContain("'--version'");
      expect(command.remoteCommand).not.toContain("'acp'");
      expect(command.remoteCommand).toContain("/home/person.one/workspace");
      expect(command.remoteCommand).toContain("HOME");
      expect(command.remoteCommand).toContain("/opt/company/bin");
      expect(command.remoteCommand).toContain("COMPANY_MODE");
      expect(command.maxBufferBytes).toBe(4096);
      expect(command.signal).toBeInstanceOf(AbortSignal);
      expect(disposeSshSandboxSession).toHaveBeenCalledWith(session);
    },
  );

  it.each(["", "1.0.0\nextra", "x".repeat(513)])(
    "rejects malformed version output and disposes the session",
    async (stdout) => {
      vi.mocked(runSshSandboxCommand).mockResolvedValue({ stdout: Buffer.from(stdout) } as never);
      await expect(
        validateAssignedVmCodingAgent({
          target,
          agent: "codex",
          createSession: async () => ({}) as never,
        }),
      ).rejects.toThrow("invalid version");
      expect(disposeSshSandboxSession).toHaveBeenCalledOnce();
    },
  );

  it("disposes the session after command failure", async () => {
    vi.mocked(runSshSandboxCommand).mockRejectedValue(new Error("not installed"));
    await expect(
      validateAssignedVmCodingAgent({
        target,
        agent: "codex",
        createSession: async () => ({}) as never,
      }),
    ).rejects.toThrow("not installed");
    expect(disposeSshSandboxSession).toHaveBeenCalledOnce();
  });
});
