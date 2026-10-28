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

const CODEX_CONFIGURATION = {
  agent: "codex" as const,
  enabled: false,
  executablePath: "",
};
const CLAUDE_CONFIGURATION = {
  agent: "claude" as const,
  enabled: true,
  executablePath: "/home/person.one/.local/bin/claude",
  environment: {
    ANTHROPIC_BASE_URL: "https://gateway.example.test",
    ADMIN_API_URL: "https://admin.example.test",
    OIDC_ISSUER_URL: "https://identity.example.test",
    OIDC_CLIENT_ID: "claude-code",
  },
};

const SETTINGS = {
  agentId: "person_one",
  userId: "user-one",
  activeTarget: "platform_server" as const,
  targetRevision: 2,
  codingAgents: [
    {
      hasSavedConfiguration: false,
      configuration: {
        agent: "claude" as const,
        enabled: false,
        executablePath: "",
        environment: {
          ANTHROPIC_BASE_URL: "",
          ADMIN_API_URL: "",
          OIDC_ISSUER_URL: "",
          OIDC_CLIENT_ID: "",
        },
      },
    },
    { hasSavedConfiguration: false, configuration: CODEX_CONFIGURATION },
    {
      hasSavedConfiguration: false,
      configuration: { agent: "opencode" as const, enabled: false, executablePath: "" },
    },
  ],
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

const CANDIDATE = {
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
  codingAgents: SETTINGS.codingAgents.map((entry) => entry.configuration),
};

const CREDENTIAL_REQUEST = {
  userId: "user-one",
  agentId: "person_one",
  sessionToken: "session-token",
  expectedRevision: 2,
  expectedCredentialRevision: 3,
  expectedAllocationId: "allocation-one",
};

const ACTIVE_CREDENTIAL_AUTH = {
  status: "active" as const,
  user: { id: "user-one" },
  session: { id: "session-one" },
  binding: { id: "binding-one", agentId: "person_one", state: "active" },
};

function createHarness() {
  const store = {
    getPersonalAgentBinding: vi.fn(async () => ({
      agentId: "person_one",
      state: "active" as const,
    })),
    getPersonalExecutionSettings: vi.fn<() => Promise<PersonalExecutionSettings>>(
      async () => SETTINGS,
    ),
    recordVmConnectionResult: vi.fn(async () => SETTINGS.allocation),
    recordVmAuthenticationFailure: vi.fn(async () => ({ recorded: true })),
    getPersonalVmCatalog: vi.fn(async () => ({
      accountId: "person.one",
      hosts: [{ id: "vm-one", label: "Development VM" }],
    })),
    getPersonalSavedVmConnections: vi.fn(async () => []),
    savePersonalVmConnection: vi.fn(async () => ({ id: "saved-one", revision: 1 })),
    getSavedVmConnectionCredential: vi.fn(async () => ({
      candidate: CANDIDATE,
      connection: {
        id: "saved-two",
        revision: 3,
        vmHostId: "vm-one",
        linuxAccount: "person.one",
        remoteHomeDir: "/users/person.one",
        remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
      },
      credentialEnvelope: {
        ciphertext: new Uint8Array([1]),
        nonce: new Uint8Array(12),
        authTag: new Uint8Array(16),
        keyId: "test-key",
        formatVersion: 1 as const,
      },
    })),
    markSavedVmConnectionUpdateRequired: vi.fn(async () => undefined),
    removePersonalSavedVmConnection: vi.fn(async () => undefined),
    preparePersonalVmCandidate: vi.fn(async () => CANDIDATE),
    replacePersonalVmAllocation: vi.fn(async () => SETTINGS.allocation),
    releasePersonalVmAllocation: vi.fn(async () => ({
      ...SETTINGS.allocation,
      status: "revoked" as const,
    })),
    commitPersonalVmSelection: vi.fn(async () => SETTINGS.allocation),
    commitPersonalVmCredential: vi.fn(async () => undefined),
    releasePersonalVmAccess: vi.fn(async () => ({
      ...SETTINGS.allocation,
      status: "revoked" as const,
    })),
    setPersonalCodingAgent: vi.fn(async () => undefined),
    recordPersonalCodingAgentCheck: vi.fn(async () => undefined),
  };
  const vault = {
    openSavedCredential: vi.fn(() => Buffer.from("saved-secret")),
    getMetadata: vi.fn(async () => ({ status: "current", revision: 3 })),
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
  const closeTerminalForAgent = vi.fn<() => Promise<void>>(async () => undefined);
  const onVmCredentialStateChanged = vi.fn(async () => undefined);
  const authenticateToken = vi.fn<
    () => Promise<typeof ACTIVE_CREDENTIAL_AUTH | { status: "unauthenticated"; reason: "revoked" }>
  >(async () => ACTIVE_CREDENTIAL_AUTH);
  const service = new EmployeeExecutionService({
    authService: {
      authenticateToken,
    } as never,
    store: store as never,
    credentialVault: vault as never,
    credentialBroker: broker as never,
    adminRpc,
    closeTerminalForAgent,
    onVmCredentialStateChanged,
    now: () => 1234,
  });
  return {
    adminRpcCall,
    broker,
    closeTerminalForAgent,
    onVmCredentialStateChanged,
    authenticateToken,
    service,
    store,
    vault,
  };
}

describe("EmployeeExecutionService", () => {
  it.each(["codex", "opencode"] as const)(
    "checks %s through the canonical VM probe",
    async (agent) => {
      const harness = createHarness();
      const configuration = { agent, enabled: false, executablePath: "" };
      harness.adminRpcCall.mockResolvedValueOnce({
        agent,
        allocationId: "allocation-one",
        targetRevision: 2,
        reportedVersion: "1.0.0",
        diagnostics: [
          { stage: "executable", status: "passed", message: `${agent} executable is ready` },
        ],
      });
      await expect(
        harness.service.checkCodingAgent({
          userId: "user-one",
          agentId: "person_one",
          configuration,
          expectedRevision: 2,
        }),
      ).resolves.toMatchObject({ agent, reportedVersion: "1.0.0" });
      expect(harness.adminRpcCall).toHaveBeenCalledWith("platformclaw-execution.checkCodingAgent", {
        agentId: "person_one",
        configuration,
        expectedRevision: 2,
      });
      expect(harness.store.getPersonalExecutionSettings).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["ownership", "revision", "readiness", "allocation", "result"])(
    "rejects coding agent validation when %s changes",
    async (change) => {
      const harness = createHarness();
      harness.adminRpcCall.mockResolvedValueOnce({
        agent: "codex",
        allocationId: change === "result" ? "other" : "allocation-one",
        targetRevision: 2,
        reportedVersion: "1.0.0",
        diagnostics: [
          { stage: "executable", status: "passed", message: "Codex executable is ready" },
        ],
      });
      harness.store.getPersonalExecutionSettings
        .mockResolvedValueOnce(SETTINGS)
        .mockResolvedValueOnce({
          ...SETTINGS,
          userId: change === "ownership" ? "other-user" : SETTINGS.userId,
          targetRevision: change === "revision" ? 3 : 2,
          allocation: {
            ...SETTINGS.allocation,
            id: change === "allocation" ? "other" : SETTINGS.allocation.id,
            status: change === "readiness" ? "connection_required" : "ready",
          },
        });
      await expect(
        harness.service.checkCodingAgent({
          userId: "user-one",
          agentId: "person_one",
          configuration: CODEX_CONFIGURATION,
          expectedRevision: 2,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    },
  );

  it("rejects stale coding agent checks before contacting the VM", async () => {
    const harness = createHarness();
    await expect(
      harness.service.checkCodingAgent({
        userId: "user-one",
        agentId: "person_one",
        configuration: CODEX_CONFIGURATION,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(harness.adminRpcCall).not.toHaveBeenCalled();
  });

  it("tests a transient password before replacing the durable credential", async () => {
    const harness = createHarness();

    await harness.service.registerCredential({
      ...CREDENTIAL_REQUEST,
      password: "secret",
    });

    expect(harness.adminRpcCall).toHaveBeenCalledWith("platformclaw-execution.testConnection", {
      agentId: "person_one",
      credentialBrokerAddress: "/run/platformclaw-credential-broker/runtime.sock",
      credentialGrantToken: "transient-grant",
    });
    expect(harness.store.commitPersonalVmCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "user-one",
        expectedAllocationId: "allocation-one",
        expectedTargetRevision: 2,
        credentialEnvelope: expect.objectContaining({ keyId: "test-key" }),
      }),
    );
    expect(harness.store.recordVmConnectionResult).not.toHaveBeenCalled();
    expect(harness.broker.revoke).toHaveBeenCalledWith("transient-grant");
    expect(harness.closeTerminalForAgent).toHaveBeenCalledWith("person_one", "credential_replaced");
    expect(harness.onVmCredentialStateChanged).toHaveBeenCalledWith({
      agentId: "person_one",
      allocationId: "allocation-one",
      targetRevision: 2,
      credentialRevision: 4,
      status: "current",
    });
  });

  it("rejects stale recovery UI before authenticating the supplied password", async () => {
    const harness = createHarness();
    await expect(
      harness.service.registerCredential({
        ...CREDENTIAL_REQUEST,
        expectedCredentialRevision: 2,
        password: "secret",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(harness.adminRpcCall).not.toHaveBeenCalled();
    expect(harness.store.commitPersonalVmCredential).not.toHaveBeenCalled();
  });

  it("revalidates browser authority after SSH authentication and before credential commit", async () => {
    const harness = createHarness();
    harness.adminRpcCall.mockImplementationOnce(async () => {
      harness.authenticateToken.mockResolvedValue({ status: "unauthenticated", reason: "revoked" });
      return {
        allocationId: "allocation-one",
        targetRevision: 2,
        remoteHomeDir: "/users/person.one",
        remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
      };
    });
    await expect(
      harness.service.registerCredential({ ...CREDENTIAL_REQUEST, password: "secret" }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(harness.store.commitPersonalVmCredential).not.toHaveBeenCalled();
    expect(harness.onVmCredentialStateChanged).not.toHaveBeenCalled();
    expect(harness.broker.revoke).toHaveBeenCalledWith("transient-grant");
  });

  it("does not notify when the atomic credential commit rejects a changed revision", async () => {
    const harness = createHarness();
    harness.store.commitPersonalVmCredential.mockRejectedValueOnce(
      new ControlPlaneConflictError(
        "execution_target_conflict",
        "VM credential changed during the connection test",
      ),
    );
    await expect(
      harness.service.registerCredential({ ...CREDENTIAL_REQUEST, password: "secret" }),
    ).rejects.toMatchObject({ code: "execution_target_conflict" });
    expect(harness.closeTerminalForAgent).not.toHaveBeenCalled();
    expect(harness.onVmCredentialStateChanged).not.toHaveBeenCalled();
  });

  it("holds VM mutation admission through credential commit and terminal cleanup", async () => {
    const harness = createHarness();
    let finishCleanup: (() => void) | undefined;
    harness.closeTerminalForAgent.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    const pending = harness.service.registerCredential({
      ...CREDENTIAL_REQUEST,
      password: "synthetic",
    });
    await vi.waitFor(() => expect(harness.closeTerminalForAgent).toHaveBeenCalledOnce());
    expect(harness.store.commitPersonalVmCredential).toHaveBeenCalledOnce();
    expect(harness.service.isConnectionAttemptActive("person_one")).toBe(true);
    expect(harness.service.isConnectionAttemptActive("another_person")).toBe(false);
    await expect(
      harness.service.changeTarget({
        userId: "user-one",
        agentId: "person_one",
        target: "platform_server",
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      harness.service.releaseVm("user-one", "person_one", "saved-one"),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(harness.store.removePersonalSavedVmConnection).not.toHaveBeenCalled();
    expect(harness.adminRpcCall).toHaveBeenCalledTimes(1);
    if (!finishCleanup) {
      throw new Error("credential cleanup did not start");
    }
    finishCleanup();
    await pending;
    expect(harness.service.isConnectionAttemptActive("person_one")).toBe(false);
    await harness.service.changeTarget({
      userId: "user-one",
      agentId: "person_one",
      target: "platform_server",
      expectedRevision: 2,
    });
    expect(harness.adminRpcCall).toHaveBeenCalledWith("platformclaw-execution.changeTarget", {
      agentId: "person_one",
      target: "platform_server",
      expectedRevision: 2,
    });
  });

  it("rechecks public target admission after loading its work location", async () => {
    const harness = createHarness();
    let loadSettings: ((settings: PersonalExecutionSettings) => void) | undefined;
    harness.store.getPersonalExecutionSettings.mockImplementationOnce(
      async () =>
        await new Promise<PersonalExecutionSettings>((resolve) => {
          loadSettings = resolve;
        }),
    );
    const changing = harness.service.changeTarget({
      userId: "user-one",
      agentId: "person_one",
      target: "platform_server",
      expectedRevision: 2,
    });
    let finishTest: ((value: unknown) => void) | undefined;
    harness.adminRpcCall.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finishTest = resolve;
        }),
    );
    const testing = harness.service.testStoredCredential("user-one", "person_one");
    await vi.waitFor(() => expect(harness.adminRpcCall).toHaveBeenCalledOnce());
    if (!loadSettings || !finishTest) {
      throw new Error("interleaved target and connection test did not start");
    }
    loadSettings(SETTINGS);
    await expect(changing).rejects.toMatchObject({ statusCode: 409 });
    expect(harness.adminRpcCall).toHaveBeenCalledTimes(1);
    finishTest({
      allocationId: "allocation-one",
      targetRevision: 2,
      remoteHomeDir: "/users/person.one",
      remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
    });
    await testing;
  });

  it("does not replace the durable credential when the transient connection test fails", async () => {
    const harness = createHarness();
    harness.adminRpcCall.mockRejectedValueOnce(new Error("authentication failed"));

    await expect(
      harness.service.registerCredential({
        ...CREDENTIAL_REQUEST,
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
        ...CREDENTIAL_REQUEST,
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
        ...CREDENTIAL_REQUEST,
        password: "wrong",
      }),
    ).rejects.toMatchObject({ statusCode: 422, message: "AD password was not accepted" });

    const unassigned = createHarness();
    unassigned.store.getPersonalExecutionSettings.mockResolvedValueOnce({
      agentId: SETTINGS.agentId,
      userId: SETTINGS.userId,
      activeTarget: SETTINGS.activeTarget,
      targetRevision: SETTINGS.targetRevision,
      codingAgents: SETTINGS.codingAgents,
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

    expect(harness.store.recordVmAuthenticationFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        allocationId: "allocation-one",
        targetRevision: 2,
        credentialRevision: 3,
      }),
    );
    expect(harness.onVmCredentialStateChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "person_one",
        status: "update_required",
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
      target: "platform_server",
      expectedRevision: 2,
    });

    expect(harness.adminRpcCall).toHaveBeenCalledWith("platformclaw-execution.changeTarget", {
      agentId: "person_one",
      target: "platform_server",
      expectedRevision: 2,
    });
  });

  it("requires a scoped saved registration for public VM activation", async () => {
    const harness = createHarness();
    await expect(
      harness.service.changeTarget({
        userId: "user-one",
        agentId: "person_one",
        target: "assigned_vm",
        expectedRevision: 2,
      }),
    ).rejects.toThrow("select a saved VM");
    expect(harness.adminRpcCall).not.toHaveBeenCalled();
  });

  it("stores Claude settings without requiring a live authentication check", async () => {
    const harness = createHarness();

    await harness.service.saveCodingAgent({
      userId: "user-one",
      agentId: "person_one",
      expectedRevision: 2,
      configuration: CLAUDE_CONFIGURATION,
    });

    expect(harness.adminRpcCall).not.toHaveBeenCalled();
    expect(harness.store.setPersonalCodingAgent).toHaveBeenCalledWith({
      actorUserId: "user-one",
      agentId: "person_one",
      expectedRevision: 2,
      configuration: CLAUDE_CONFIGURATION,
      updatedAt: 1234,
    });
    expect(harness.closeTerminalForAgent).not.toHaveBeenCalled();
  });

  it("allows an owned disconnected VM configuration to be disabled without ending active work", async () => {
    const harness = createHarness();
    harness.store.getPersonalExecutionSettings.mockResolvedValue({
      ...SETTINGS,
      allocation: { ...SETTINGS.allocation, status: "connection_required" },
    });
    const disabled = { ...CLAUDE_CONFIGURATION, enabled: false };

    await harness.service.saveCodingAgent({
      userId: "user-one",
      agentId: "person_one",
      expectedRevision: 2,
      configuration: disabled,
    });

    expect(harness.store.setPersonalCodingAgent).toHaveBeenCalledWith(
      expect.objectContaining({ configuration: disabled }),
    );
    expect(harness.adminRpcCall).not.toHaveBeenCalled();
    expect(harness.closeTerminalForAgent).not.toHaveBeenCalled();
  });

  it("registers the verified VM then activates through the guarded Gateway switch", async () => {
    const harness = createHarness();

    await harness.service.selectVm({
      userId: "user-one",
      agentId: "person_one",
      vmHostId: "vm-one",
      linuxAccount: "person.one",
      password: "secret",
      expectedRevision: 2,
    });

    expect(harness.adminRpcCall).toHaveBeenCalledWith(
      "platformclaw-execution.testCandidateConnection",
      expect.objectContaining({
        target: expect.objectContaining({ allocationId: "candidate:vm-one" }),
      }),
    );
    expect(harness.store.savePersonalVmConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        vmHostId: "vm-one",
        linuxAccount: "person.one",
        remoteHomeDir: "/users/person.one",
        credentialEnvelope: expect.objectContaining({ keyId: "test-key" }),
      }),
    );
    expect(harness.adminRpcCall).toHaveBeenLastCalledWith("platformclaw-execution.changeTarget", {
      agentId: "person_one",
      target: "assigned_vm",
      connectionId: "saved-one",
      expectedConnectionRevision: 1,
      expectedRevision: 2,
    });
    expect(harness.store.commitPersonalVmSelection).not.toHaveBeenCalled();
  });

  it("probes scoped saved credentials without replacing the active credential", async () => {
    const harness = createHarness();
    harness.store.getPersonalExecutionSettings.mockResolvedValue({
      ...SETTINGS,
      activeTarget: "assigned_vm",
    });
    const secret = Buffer.from("saved-secret");
    harness.vault.openSavedCredential.mockReturnValue(secret);
    await harness.service.changeTarget({
      userId: "user-one",
      agentId: "person_one",
      target: "assigned_vm",
      expectedRevision: 2,
      connectionId: "saved-two",
    });
    expect(secret.every((byte) => byte === 0)).toBe(true);
    expect(harness.adminRpcCall).toHaveBeenLastCalledWith("platformclaw-execution.changeTarget", {
      agentId: "person_one",
      target: "assigned_vm",
      connectionId: "saved-two",
      expectedConnectionRevision: 3,
      expectedRevision: 2,
    });
    expect(harness.vault.replace).not.toHaveBeenCalled();
    expect(harness.broker.issueForUser).not.toHaveBeenCalled();
  });

  it.each(["authentication", "transport"])(
    "preserves VM1 when destination %s fails",
    async (failure) => {
      const harness = createHarness();
      harness.store.getPersonalExecutionSettings.mockResolvedValue({
        ...SETTINGS,
        activeTarget: "assigned_vm",
      });
      harness.adminRpcCall.mockRejectedValueOnce(
        failure === "authentication"
          ? new GatewayAdminRpcError("authentication failed", "INVALID_REQUEST", 400, {
              kind: "vm_authentication_failed",
            })
          : new Error("unreachable"),
      );
      await expect(
        harness.service.changeTarget({
          userId: "user-one",
          agentId: "person_one",
          target: "assigned_vm",
          expectedRevision: 2,
          connectionId: "saved-two",
        }),
      ).rejects.toThrow();
      expect(harness.adminRpcCall).toHaveBeenCalledTimes(1);
      expect(harness.vault.replace).not.toHaveBeenCalled();
      expect(harness.store.recordVmConnectionResult).not.toHaveBeenCalled();
      expect(harness.closeTerminalForAgent).not.toHaveBeenCalled();
      expect(harness.store.markSavedVmConnectionUpdateRequired).toHaveBeenCalledTimes(
        failure === "authentication" ? 1 : 0,
      );
      expect(harness.broker.revoke).toHaveBeenCalledWith("transient-grant");
    },
  );

  it("forgets an inactive saved VM without releasing the active allocation", async () => {
    const harness = createHarness();
    await harness.service.releaseVm("user-one", "person_one", "saved-two");
    expect(harness.store.removePersonalSavedVmConnection).toHaveBeenCalledWith({
      actorUserId: "user-one",
      agentId: "person_one",
      connectionId: "saved-two",
      removedAt: 1234,
    });
    expect(harness.store.releasePersonalVmAccess).not.toHaveBeenCalled();
    expect(harness.closeTerminalForAgent).not.toHaveBeenCalled();
  });

  it("allows repeated saved switches without consuming password-attempt admission", async () => {
    const harness = createHarness();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await harness.service.changeTarget({
        userId: "user-one",
        agentId: "person_one",
        target: "assigned_vm",
        expectedRevision: 2,
        connectionId: "saved-two",
      });
    }
    expect(
      harness.adminRpcCall.mock.calls.filter(
        ([method]) => method === "platformclaw-execution.changeTarget",
      ),
    ).toHaveLength(8);
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
  it("requires the displayed VM revisions and uses the authenticated cookie for credential recovery", async () => {
    const harness = createHarness();
    let responseBody = "";
    const response = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: (body?: unknown) => {
        responseBody = typeof body === "string" ? body : "";
      },
    } as unknown as ServerResponse;
    const req = {
      url: "/platformclaw/api/execution/credential",
      method: "POST",
      headers: { cookie: "platformclaw_session=session-token" },
    } as IncomingMessage;
    await handlePlatformClawEmployeeExecutionRequest(req, response, {
      service: harness.service,
      isMutationOriginAllowed: () => true,
      readJsonBody: async () => ({ ok: true, value: { password: "synthetic" } }),
    });
    expect(response.statusCode).toBe(400);
    expect(harness.broker.issueTransient).not.toHaveBeenCalled();
    await handlePlatformClawEmployeeExecutionRequest(req, response, {
      service: harness.service,
      isMutationOriginAllowed: () => true,
      readJsonBody: async () => ({
        ok: true,
        value: {
          password: "synthetic",
          expectedRevision: 2,
          expectedCredentialRevision: 3,
          expectedAllocationId: "allocation-one",
          sessionToken: "ignored-body-token",
        },
      }),
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(responseBody)).toMatchObject({ credentialRevision: 3 });
    expect(harness.authenticateToken).toHaveBeenCalledWith("session-token", false);
    expect(harness.store.commitPersonalVmCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedBindingId: "binding-one",
        expectedSessionId: "session-one",
        expectedCredentialRevision: 3,
      }),
    );
  });
  it("routes an authenticated employee detection through the internal admin RPC", async () => {
    const harness = createHarness();
    harness.adminRpcCall.mockResolvedValueOnce({
      agent: "claude",
      allocationId: "allocation-one",
      targetRevision: 2,
      executablePath: "/home/person.one/.local/bin/claude",
      environment: { OIDC_CLIENT_ID: "claude-code" },
      diagnostics: [
        { stage: "executable", status: "passed", message: "Claude Code executable found" },
      ],
    });
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;

    await handlePlatformClawEmployeeExecutionRequest(
      {
        url: "/platformclaw/api/execution/coding-agent",
        method: "POST",
        headers: { cookie: "platformclaw_session=test-token" },
      } as IncomingMessage,
      response,
      {
        service: harness.service,
        isMutationOriginAllowed: () => true,
        readJsonBody: async () => ({
          ok: true,
          value: { action: "detect", agent: "claude", expectedRevision: 2 },
        }),
      },
    );

    expect(response.statusCode).toBe(200);
    expect(harness.adminRpcCall).toHaveBeenCalledWith("platformclaw-execution.detectCodingAgent", {
      agentId: "person_one",
      agent: "claude",
      expectedRevision: 2,
    });
  });

  it.each([
    { agent: "opencode", expectedRevision: 2, status: 200 },
    { agent: "other", expectedRevision: 2, status: 400 },
    { agent: "codex", expectedRevision: -1, status: 400 },
  ])(
    "validates the coding agent detection route input ($agent, $expectedRevision)",
    async ({ agent, expectedRevision, status }) => {
      const detectCodingAgent = vi.fn(async () => ({
        agent,
        diagnostics: [{ stage: "executable", status: "passed", message: "ready" }],
      }));
      const response = {
        statusCode: 0,
        setHeader: vi.fn(),
        end: vi.fn(),
      } as unknown as ServerResponse;
      const handled = await handlePlatformClawEmployeeExecutionRequest(
        {
          url: "/platformclaw/api/execution/coding-agent",
          method: "POST",
          headers: { cookie: "platformclaw_session=test-token" },
        } as IncomingMessage,
        response,
        {
          service: {
            authenticate: async () => ({
              user: { id: "user-one" },
              binding: { agentId: "person_one" },
            }),
            detectCodingAgent,
          } as unknown as EmployeeExecutionService,
          isMutationOriginAllowed: () => true,
          readJsonBody: async () => ({
            ok: true,
            value: { action: "detect", agent, expectedRevision, agentId: "other-person" },
          }),
        },
      );
      expect(handled).toBe(true);
      expect(response.statusCode).toBe(status);
      if (status === 200) {
        expect(detectCodingAgent).toHaveBeenCalledWith({
          userId: "user-one",
          agentId: "person_one",
          agent,
          expectedRevision,
        });
      } else {
        expect(detectCodingAgent).not.toHaveBeenCalled();
      }
    },
  );

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
