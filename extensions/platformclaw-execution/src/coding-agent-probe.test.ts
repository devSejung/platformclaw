import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { AssignedVmTargetSnapshot } from "./backend.js";
import { checkAssignedVmCodingAgent } from "./coding-agent-probe.js";

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
    { agent: "codex", enabled: true, executablePath: "/usr/bin/codex" },
    { agent: "opencode", enabled: false, executablePath: "" },
  ],
};

const FIXTURE = String.raw`
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
let client;
new AgentSideConnection((connection) => {
  client = connection;
  return {
    initialize: () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }),
    newSession: () => ({ sessionId: "probe" }),
    prompt: async ({ sessionId, prompt }) => {
      const requested = prompt[0].text.match(/ACP_OK_[0-9a-f]+/)?.[0] ?? "wrong";
      await client.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: requested } } });
      return { stopReason: "end_turn" };
    },
    cancel: () => {},
    closeSession: () => ({}),
  };
}, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
`;

describe("coding agent ACP check", () => {
  it("requires a completed, unique ACP response over a real process pipe", async () => {
    const result = await checkAssignedVmCodingAgent({
      target: TARGET,
      configuration: { agent: "codex", enabled: true, executablePath: "/usr/bin/codex" },
      launch: async () =>
        spawn(process.execPath, ["--input-type=module", "-e", FIXTURE], {
          stdio: ["pipe", "pipe", "pipe"],
        }),
    });

    expect(result.diagnostics).toContainEqual({
      stage: "acp",
      status: "passed",
      message: "ACP returned the expected validation response.",
    });
  });

  it("bounds cleanup and escalates when the adapter hangs and ignores SIGTERM", async () => {
    const hangingFixture = FIXTURE.replace(
      "closeSession: () => ({}),",
      "closeSession: () => new Promise(() => {}),",
    ).replace("let client;", 'let client; process.on("SIGTERM", () => {});');
    const startedAt = Date.now();
    const result = await checkAssignedVmCodingAgent({
      target: TARGET,
      configuration: { agent: "codex", enabled: true, executablePath: "/usr/bin/codex" },
      launch: async () =>
        spawn(process.execPath, ["--input-type=module", "-e", hangingFixture], {
          stdio: ["pipe", "pipe", "pipe"],
        }),
    });

    expect(result.diagnostics.at(-1)?.status).toBe("passed");
    expect(Date.now() - startedAt).toBeLessThan(6_000);
  });
});
