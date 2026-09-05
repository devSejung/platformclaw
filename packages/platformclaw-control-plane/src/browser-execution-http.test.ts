import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  EmployeeExecutionService,
  handlePlatformClawEmployeeExecutionRequest,
  PLATFORMCLAW_EXECUTION_TARGET_PATH,
} from "./browser-execution-http.js";
import { ControlPlaneConflictError } from "./contracts.js";
import type { PersonalExecutionSettings } from "./execution-contracts.js";
import { GatewayAdminRpcError, type GatewayAdminRpc } from "./gateway-admin-rpc-client.js";

const SETTINGS = {
  agentId: "person_one",
  userId: "user-one",
  activeTarget: "platform_server" as const,
  targetRevision: 2,
  allocation: {
    id: "allocation-one",
    vmHostId: "vm-one",
    status: "ready" as const,
    vmLabel: "Development VM",
    safeConnectLabel: "SafeConnect",
    linuxAccount: "person.one",
    remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
  },
};

function createHarness() {
  const store = {
    getPersonalExecutionSettings: vi.fn<() => Promise<PersonalExecutionSettings>>(
      async () => SETTINGS,
    ),
    recordVmConnectionResult: vi.fn(async () => SETTINGS.allocation),
    getPersonalVmCatalog: vi.fn(async () => ({
      accountId: "person.one",
      hosts: [{ id: "vm-one", label: "Development VM" }],
    })),
    preparePersonalVmCandidate: vi.fn(async () => ({
      kind: "assigned_vm" as const,
      agentId: "person_one",
      userId: "user-one",
      targetId: "candidate:vm-one",
      revision: 2,
      allocationId: "candidate:vm-one",
      allocationStatus: "assigned" as const,
      vmLabel: "Development VM",
      safeConnectLabel: "SafeConnect",
      endpointHost: "safeconnect.example.test",
      endpointPort: 44_422,
      adDomain: "example.test",
      adAccount: "person.one",
      targetAddress: "192.0.2.10",
      linuxAccount: "person.one",
      hostKeyAlgorithm: "ssh-ed25519",
      hostKeyPublicKey: "key",
      hostKeyFingerprint: "SHA256:test",
    })),
    replacePersonalVmAllocation: vi.fn(async () => SETTINGS.allocation),
    releasePersonalVmAllocation: vi.fn(async () => ({
      ...SETTINGS.allocation,
      status: "revoked" as const,
    })),
    commitPersonalVmSelection: vi.fn(async () => SETTINGS.allocation),
    releasePersonalVmAccess: vi.fn(async () => ({
      ...SETTINGS.allocation,
      status: "revoked" as const,
    })),
    setPersonalClaudeCode: vi.fn(async () => undefined),
  };
  const vault = {
    getMetadata: vi.fn(async () => ({ status: "current" })),
    replace: vi.fn(async () => ({ status: "current" })),
    delete: vi.fn(async () => true),
    sealForStorage: vi.fn(() => ({
      ciphertext: new Uint8Array([1]),
      nonce: new Uint8Array(12),
      authTag: new Uint8Array(16),
      keyId: "test-key",
      formatVersion: 1 as const,
    })),
  };
  const broker = {
    address: "/run/platformclaw-credential-broker/runtime.sock",
    issueTransient: vi.fn(() => ({ token: "transient-grant", expiresAt: Date.now() + 1_000 })),
    issueForUser: vi.fn(() => ({ token: "stored-grant", expiresAt: Date.now() + 1_000 })),
    revoke: vi.fn(() => true),
  };
  const adminRpcCall = vi.fn<(method: string, params: unknown) => Promise<unknown>>(
    async (method) => ({
      allocationId:
        method === "platformclaw-execution.testCandidateConnection"
          ? "candidate:vm-one"
          : "allocation-one",
      targetRevision: 2,
      remoteHomeDir: "/users/person.one",
      remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
    }),
  );
  const adminRpc: GatewayAdminRpc = {
    call: async <T>(method: string, params: unknown) => (await adminRpcCall(method, params)) as T,
  };
  const closeTerminalForAgent = vi.fn(async () => undefined);
  const service = new EmployeeExecutionService({
    authService: {} as never,
    store: store as never,
    credentialVault: vault as never,
    credentialBroker: broker as never,
    adminRpc,
    closeTerminalForAgent,
    now: () => 1234,
  });
  return { adminRpcCall, broker, closeTerminalForAgent, service, store, vault };
}

describe("EmployeeExecutionService", () => {
  it("tests a transient password before replacing the durable credential", async () => {
    const harness = createHarness();

    await harness.service.registerCredential({
      userId: "user-one",
      agentId: "person_one",
      password: "secret",
    });

    expect(harness.adminRpcCall).toHaveBeenCalledWith("platformclaw-execution.testConnection", {
      agentId: "person_one",
      credentialBrokerAddress: "/run/platformclaw-credential-broker/runtime.sock",
      credentialGrantToken: "transient-grant",
    });
    expect(harness.vault.replace).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-one", password: "secret" }),
    );
    expect(harness.store.recordVmConnectionResult).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedAllocationId: "allocation-one",
        expectedTargetRevision: 2,
        result: expect.objectContaining({ status: "ready" }),
      }),
    );
    expect(harness.broker.revoke).toHaveBeenCalledWith("transient-grant");
    expect(harness.closeTerminalForAgent).toHaveBeenCalledWith("person_one", "credential_replaced");
  });

  it("does not replace the durable credential when the transient connection test fails", async () => {
    const harness = createHarness();
    harness.adminRpcCall.mockRejectedValueOnce(new Error("authentication failed"));

    await expect(
      harness.service.registerCredential({
        userId: "user-one",
        agentId: "person_one",
        password: "wrong",
      }),
    ).rejects.toThrow("authentication failed");

    expect(harness.vault.replace).not.toHaveBeenCalled();
    expect(harness.store.recordVmConnectionResult).not.toHaveBeenCalled();
    expect(harness.broker.revoke).toHaveBeenCalledWith("transient-grant");
  });

  it("classifies user-correctable credential and assignment failures", async () => {
    const invalid = createHarness();
    await expect(
      invalid.service.registerCredential({
        userId: "user-one",
        agentId: "person_one",
        password: "",
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: "AD password is required" });

    const rejected = createHarness();
    rejected.adminRpcCall.mockRejectedValueOnce(
      new GatewayAdminRpcError("development VM authentication failed", "INVALID_REQUEST", 400, {
        kind: "vm_authentication_failed",
      }),
    );
    await expect(
      rejected.service.registerCredential({
        userId: "user-one",
        agentId: "person_one",
        password: "wrong",
      }),
    ).rejects.toMatchObject({ statusCode: 422, message: "AD password was not accepted" });

    const unassigned = createHarness();
    unassigned.store.getPersonalExecutionSettings.mockResolvedValueOnce({
      agentId: SETTINGS.agentId,
      userId: SETTINGS.userId,
      activeTarget: SETTINGS.activeTarget,
      targetRevision: SETTINGS.targetRevision,
    });
    await expect(
      unassigned.service.testStoredCredential("user-one", "person_one"),
    ).rejects.toMatchObject({ statusCode: 409, message: "development VM is not assigned" });
  });

  it("does not downgrade a ready VM for a Gateway infrastructure failure", async () => {
    const harness = createHarness();
    harness.adminRpcCall.mockRejectedValueOnce(new Error("private Gateway unavailable"));

    await expect(harness.service.testStoredCredential("user-one", "person_one")).rejects.toThrow(
      "unavailable",
    );

    expect(harness.store.recordVmConnectionResult).not.toHaveBeenCalled();
    expect(harness.broker.revoke).toHaveBeenCalledWith("stored-grant");
  });

  it("marks only a classified SSH authentication failure as connection required", async () => {
    const harness = createHarness();
    harness.adminRpcCall.mockRejectedValueOnce(
      new GatewayAdminRpcError("development VM authentication failed", "INVALID_REQUEST", 400, {
        kind: "vm_authentication_failed",
      }),
    );

    await expect(harness.service.testStoredCredential("user-one", "person_one")).rejects.toThrow(
      "authentication failed",
    );

    expect(harness.store.recordVmConnectionResult).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedAllocationId: "allocation-one",
        expectedTargetRevision: 2,
        result: {
          status: "connection_required",
          failureCode: "vm_authentication_failed",
        },
      }),
    );
  });

  it("serializes and rate-limits connection attempts per agent", async () => {
    const harness = createHarness();
    let release!: () => void;
    harness.adminRpcCall.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          release = () =>
            resolve({
              allocationId: "allocation-one",
              targetRevision: 2,
              remoteHomeDir: "/users/person.one",
              remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
            });
        }),
    );
    const first = harness.service.testStoredCredential("user-one", "person_one");
    await vi.waitFor(() => expect(harness.adminRpcCall).toHaveBeenCalledOnce());
    await expect(harness.service.testStoredCredential("user-one", "person_one")).rejects.toThrow(
      "already in progress",
    );
    release();
    await first;

    harness.adminRpcCall.mockRejectedValue(new Error("unavailable"));
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await expect(harness.service.testStoredCredential("user-one", "person_one")).rejects.toThrow(
        "unavailable",
      );
    }
    await expect(harness.service.testStoredCredential("user-one", "person_one")).rejects.toThrow(
      "too many connection attempts",
    );
  });

  it("routes a target change through the trusted admin RPC", async () => {
    const harness = createHarness();

    await harness.service.changeTarget({
      userId: "user-one",
      agentId: "person_one",
      target: "assigned_vm",
      expectedRevision: 2,
    });

    expect(harness.adminRpcCall).toHaveBeenCalledWith("platformclaw-execution.changeTarget", {
      agentId: "person_one",
      target: "assigned_vm",
      expectedRevision: 2,
    });
  });

  it("validates and stores a per-user Claude Code executable", async () => {
    const harness = createHarness();
    harness.adminRpcCall.mockResolvedValueOnce({
      allocationId: "allocation-one",
      targetRevision: 2,
      executablePath: "/home/person.one/.local/bin/claude",
      reportedVersion: "2.1.0 (Claude Code)",
    });

    await harness.service.configureClaudeCode({
      userId: "user-one",
      agentId: "person_one",
      expectedRevision: 2,
      executablePath: "/home/person.one/.local/bin/claude",
    });

    expect(harness.adminRpcCall).toHaveBeenCalledWith("platformclaw-execution.validateClaudeCode", {
      agentId: "person_one",
      executablePath: "/home/person.one/.local/bin/claude",
    });
    expect(harness.store.setPersonalClaudeCode).toHaveBeenCalledWith({
      actorUserId: "user-one",
      agentId: "person_one",
      expectedRevision: 2,
      executablePath: "/home/person.one/.local/bin/claude",
      reportedVersion: "2.1.0 (Claude Code)",
      validatedAt: 1234,
    });
    expect(harness.closeTerminalForAgent).toHaveBeenCalledWith("person_one", "claude_code_changed");
  });

  it("tests a self-selected VM before atomically replacing the allocation", async () => {
    const harness = createHarness();

    await harness.service.selectVm({
      userId: "user-one",
      agentId: "person_one",
      vmHostId: "vm-one",
      linuxAccount: "person.one",
      password: "secret",
    });

    expect(harness.adminRpcCall).toHaveBeenCalledWith(
      "platformclaw-execution.testCandidateConnection",
      expect.objectContaining({
        target: expect.objectContaining({ allocationId: "candidate:vm-one" }),
      }),
    );
    expect(harness.store.commitPersonalVmSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        vmHostId: "vm-one",
        linuxAccount: "person.one",
        remoteHomeDir: "/users/person.one",
        credentialEnvelope: expect.objectContaining({ keyId: "test-key" }),
      }),
    );
  });

  it("releases the inactive allocation and credential through one store transaction", async () => {
    const harness = createHarness();

    await harness.service.releaseVm("user-one", "person_one");

    expect(harness.store.releasePersonalVmAccess).toHaveBeenCalledWith({
      actorUserId: "user-one",
      agentId: "person_one",
      releasedAt: 1234,
    });
    expect(harness.vault.delete).not.toHaveBeenCalled();
  });

  it("rejects another user's execution settings", async () => {
    const harness = createHarness();

    await expect(harness.service.getSettings("user-two", "person_one")).rejects.toThrow(
      "unavailable",
    );
    expect(harness.vault.getMetadata).not.toHaveBeenCalled();
  });
});

describe("employee execution HTTP errors", () => {
  it("returns 409 when a connection result races with a target change", async () => {
    let responseBody = "";
    const response = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: (body?: unknown) => {
        responseBody = typeof body === "string" ? body : "";
      },
    } as unknown as ServerResponse;
    const service = {
      authenticate: vi.fn(async () => ({
        user: { id: "user-one" },
        binding: { agentId: "person_one" },
      })),
      changeTarget: vi.fn(async () => {
        throw new ControlPlaneConflictError(
          "execution_target_conflict",
          "execution target changed during connection test",
        );
      }),
    } as unknown as EmployeeExecutionService;

    await handlePlatformClawEmployeeExecutionRequest(
      {
        url: PLATFORMCLAW_EXECUTION_TARGET_PATH,
        method: "POST",
        headers: { cookie: "platformclaw_session=test-token" },
      } as IncomingMessage,
      response,
      {
        service,
        isMutationOriginAllowed: () => true,
        readJsonBody: async () => ({
          ok: true,
          value: { target: "assigned_vm", expectedRevision: 2 },
        }),
      },
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(responseBody)).toEqual({
      error: "execution target changed during connection test",
    });
  });
});
