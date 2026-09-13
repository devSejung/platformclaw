import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import { detectAssignedVmCodingAgent } from "./coding-agent-probe.js";

const { runCommand, dispose } = vi.hoisted(() => ({
  runCommand: vi.fn(),
  dispose: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/sandbox")>()),
  runSshSandboxCommand: runCommand,
  disposeSshSandboxSession: dispose,
}));

const TARGET = {
  kind: "assigned_vm",
  agentId: "person_one",
  targetId: "vm-one",
  revision: 9,
  allocationId: "allocation-one",
  credentialRevision: 3,
  remoteHomeDir: "/home/person.one",
  remoteWorkspaceDir: "/home/person.one/workspace",
  codingAgents: [],
} as unknown as AssignedVmTargetSnapshot;

function extractMarker(command: string): string {
  const marker = command.match(/PLATFORMCLAW_[0-9a-f]{24}/u)?.[0];
  if (!marker) {
    throw new Error("marker missing");
  }
  return marker;
}

describe("coding agent shell detection", () => {
  beforeEach(() => {
    runCommand.mockReset();
    dispose.mockClear();
  });

  it("ignores shell banners and decodes only its bounded structured frame", async () => {
    runCommand.mockImplementation(async ({ remoteCommand }: { remoteCommand: string }) => {
      const marker = extractMarker(remoteCommand);
      const encoded = (value: string) => Buffer.from(value).toString("base64");
      return {
        stdout: Buffer.from(
          `welcome token=do-not-parse\n${marker}\npath=${encoded("/home/person.one/.local/bin/claude")}\nversion=${encoded("2.0.0")}\nenv.ANTHROPIC_BASE_URL=${encoded("https://gateway.example")}\nenv.ADMIN_API_URL=${encoded("https://admin.example")}\nenv.OIDC_ISSUER_URL=${encoded("https://issuer.example")}\nenv.OIDC_CLIENT_ID=${encoded("personal-client")}\n${marker}_END\ntrailer`,
        ),
        stderr: Buffer.from("startup banner"),
      };
    });

    const result = await detectAssignedVmCodingAgent({
      target: TARGET,
      agent: "claude",
      createSession: async () => ({}) as never,
    });

    expect(result).toMatchObject({
      executablePath: "/home/person.one/.local/bin/claude",
      environment: { OIDC_CLIENT_ID: "personal-client" },
    });
    expect(runCommand.mock.calls[0]?.[0]).toMatchObject({ maxBufferBytes: 64 * 1024 });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("still returns Claude environment draft values when the executable is missing", async () => {
    runCommand.mockImplementation(async ({ remoteCommand }: { remoteCommand: string }) => {
      const marker = extractMarker(remoteCommand);
      return {
        stdout: Buffer.from(
          `${marker}\npath=\nversion=\nenv.ANTHROPIC_BASE_URL=aHR0cHM6Ly9nYXRld2F5LmV4YW1wbGU=\nenv.ADMIN_API_URL=\nenv.OIDC_ISSUER_URL=\nenv.OIDC_CLIENT_ID=\n${marker}_END\n`,
        ),
        stderr: Buffer.alloc(0),
      };
    });

    const result = await detectAssignedVmCodingAgent({
      target: TARGET,
      agent: "claude",
      createSession: async () => ({}) as never,
    });
    expect(result.executablePath).toBeUndefined();
    expect(result.environment?.ANTHROPIC_BASE_URL).toBe("https://gateway.example");
  });
});
