import {
  parseCodingAgentVmProbeResult,
  type CodingAgentConfiguration,
  type CodingAgentId,
  type CodingAgentProbeResult,
} from "@platformclaw/coding-agent-contract";
import type { BrowserAuthService } from "./browser-auth-service.js";
import {
  assertCurrentVmCandidate,
  requireVmCredentialBrowserAuthority,
} from "./browser-execution-authorization.js";
import {
  connectionTestResult,
  vmConnectionFailureKind,
  isVmAuthenticationFailure,
  type ConnectionTestResult,
} from "./browser-execution-connection.js";
import { EmployeeExecutionHttpError } from "./browser-execution-errors.js";
import type { ControlPlaneStore } from "./contracts.js";
import type {
  ControlPlaneAtomicVmCredentialStore,
  ControlPlaneEmployeeExecutionStore,
  ControlPlaneSavedVmConnectionStore,
  ControlPlaneVmSelfServiceStore,
  PersonalExecutionSettings,
  VmCredentialStateChange,
  ControlPlaneVmAuthenticationFailureStore,
} from "./execution-contracts.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import type { SshCredentialBroker } from "./ssh-credential-broker.js";
import type { SshCredentialVault } from "./ssh-credential-vault.js";

const CONNECTION_ATTEMPT_WINDOW_MS = 5 * 60_000;
const CONNECTION_ATTEMPT_LIMIT = 5;

type VmCredentialRegistration = {
  userId: string;
  agentId: string;
  password: string;
  sessionToken: string;
  expectedRevision: number;
  expectedCredentialRevision: number;
  expectedAllocationId: string;
};

export { EmployeeExecutionHttpError } from "./browser-execution-errors.js";

type EmployeeExecutionStore = ControlPlaneStore &
  ControlPlaneEmployeeExecutionStore &
  ControlPlaneVmSelfServiceStore &
  ControlPlaneSavedVmConnectionStore &
  ControlPlaneVmAuthenticationFailureStore &
  ControlPlaneAtomicVmCredentialStore;

type EmployeeExecutionServiceOptions = {
  authService: BrowserAuthService;
  store: EmployeeExecutionStore;
  credentialVault?: SshCredentialVault;
  credentialBroker?: Pick<
    SshCredentialBroker,
    "address" | "issueForUser" | "issueTransient" | "revoke"
  >;
  adminRpc: GatewayAdminRpc;
  closeTerminalForAgent?: (agentId: string, reason: string) => Promise<void>;
  onVmCredentialStateChanged?: (change: VmCredentialStateChange) => Promise<void>;
  now?: () => number;
};

function publicCodingAgentProbe(
  result: ReturnType<typeof parseCodingAgentVmProbeResult>,
): CodingAgentProbeResult {
  return {
    agent: result.agent,
    ...(result.executablePath ? { executablePath: result.executablePath } : {}),
    ...(result.reportedVersion ? { reportedVersion: result.reportedVersion } : {}),
    ...(result.environment ? { environment: result.environment } : {}),
    diagnostics: result.diagnostics,
  };
}

export { isVmAuthenticationFailure } from "./browser-execution-connection.js";

export class EmployeeExecutionService {
  private readonly now: () => number;
  private readonly activeConnectionTests = new Set<string>();
  private readonly connectionAttempts = new Map<string, number[]>();

  constructor(private readonly options: EmployeeExecutionServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  isConnectionAttemptActive(agentId: string): boolean {
    return this.activeConnectionTests.has(agentId);
  }

  async authenticate(token: string) {
    const auth = await this.options.authService.authenticateToken(token);
    if (auth.status !== "active") {
      return null;
    }
    const binding = await this.options.store.getPersonalAgentBinding(auth.user.id);
    if (!binding || binding.state !== "active") {
      return null;
    }
    return { user: auth.user, binding };
  }

  async getSettings(userId: string, agentId: string) {
    const settings = await this.requireOwnedSettings(userId, agentId);
    const catalog = await this.options.store.getPersonalVmCatalog({
      actorUserId: userId,
      agentId,
    });
    const credential = this.options.credentialVault
      ? await this.options.credentialVault.getMetadata({ actorUserId: userId, userId })
      : null;
    const savedVms = await this.options.store.getPersonalSavedVmConnections({
      actorUserId: userId,
      agentId,
    });
    return {
      ...this.project(settings, credential?.status ?? "missing", catalog),
      credentialRevision: credential?.revision ?? 0,
      ...(credential?.lastAuthFailureAt === undefined
        ? {}
        : { credentialLastAuthFailureAt: credential.lastAuthFailureAt }),
      savedVms,
    };
  }

  async selectVm(params: {
    userId: string;
    agentId: string;
    vmHostId: string;
    linuxAccount: string;
    password: string;
    expectedRevision: number;
  }) {
    return await this.withConnectionAttempt(params.agentId, async () => {
      const { credentialBroker, credentialVault } = this.requireCredentialRuntime();
      const settings = await this.requireOwnedSettings(params.userId, params.agentId);
      if (settings.targetRevision !== params.expectedRevision) {
        throw new EmployeeExecutionHttpError(409, "work location changed; reload and retry");
      }
      if (!params.password || Buffer.byteLength(params.password, "utf8") > 4 * 1024) {
        throw new EmployeeExecutionHttpError(400, "AD password is required");
      }
      const candidate = await this.options.store.preparePersonalVmCandidate({
        actorUserId: params.userId,
        agentId: params.agentId,
        vmHostId: params.vmHostId,
        linuxAccount: params.linuxAccount,
      });
      const grant = credentialBroker.issueTransient(params.password, async () => {
        const current = await this.options.store.preparePersonalVmCandidate({
          actorUserId: params.userId,
          agentId: params.agentId,
          vmHostId: params.vmHostId,
          linuxAccount: candidate.linuxAccount,
        });
        assertCurrentVmCandidate(candidate, current);
      });
      let connection: ConnectionTestResult;
      try {
        connection = connectionTestResult(
          await this.options.adminRpc.call("platformclaw-execution.testCandidateConnection", {
            target: { ...candidate, remoteHomeDir: "/", remoteWorkspaceDir: "/" },
            credentialBrokerAddress: credentialBroker.address,
            credentialGrantToken: grant.token,
          }),
        );
      } catch (error) {
        if (isVmAuthenticationFailure(error)) {
          throw new EmployeeExecutionHttpError(422, "AD password was not accepted");
        }
        throw error;
      } finally {
        credentialBroker.revoke(grant.token);
      }
      if (
        connection.allocationId !== candidate.allocationId ||
        connection.targetRevision !== candidate.revision
      ) {
        throw new EmployeeExecutionHttpError(409, "development VM selection changed during test");
      }
      const saved = await this.options.store.savePersonalVmConnection({
        actorUserId: params.userId,
        agentId: params.agentId,
        vmHostId: params.vmHostId,
        linuxAccount: candidate.linuxAccount,
        remoteHomeDir: connection.remoteHomeDir,
        remoteWorkspaceDir: connection.remoteWorkspaceDir,
        credentialEnvelope: credentialVault.sealForStorage(params.userId, params.password),
        candidate,
        expectedRevision: params.expectedRevision,
        verifiedAt: this.now(),
      });
      await this.options.adminRpc.call("platformclaw-execution.changeTarget", {
        agentId: params.agentId,
        target: "assigned_vm",
        connectionId: saved.id,
        expectedConnectionRevision: saved.revision,
        expectedRevision: params.expectedRevision,
      });
      await this.options.closeTerminalForAgent?.(params.agentId, "work_location_changed");
      return await this.getSettings(params.userId, params.agentId);
    });
  }

  async releaseVm(userId: string, agentId: string, connectionId?: string) {
    this.assertNoConnectionAttempt(agentId);
    if (connectionId) {
      await this.options.store.removePersonalSavedVmConnection({
        actorUserId: userId,
        agentId,
        connectionId,
        removedAt: this.now(),
      });
      return await this.getSettings(userId, agentId);
    }
    const settings = await this.requireOwnedSettings(userId, agentId);
    if (settings.allocation && settings.activeTarget !== "platform_server") {
      throw new EmployeeExecutionHttpError(
        409,
        "switch to the Basic workspace before releasing development VM",
      );
    }
    const releasedAt = this.now();
    this.assertNoConnectionAttempt(agentId);
    await this.options.store.releasePersonalVmAccess({
      actorUserId: userId,
      agentId,
      releasedAt,
    });
    await this.options.closeTerminalForAgent?.(agentId, "allocation_released");
    return await this.getSettings(userId, agentId);
  }

  async registerCredential(params: VmCredentialRegistration) {
    return await this.withConnectionAttempt(params.agentId, async () => {
      return await this.registerCredentialLocked(params);
    });
  }

  private async registerCredentialLocked(params: VmCredentialRegistration) {
    const { credentialBroker, credentialVault } = this.requireCredentialRuntime();
    const settings = await this.requireOwnedSettings(params.userId, params.agentId);
    const authority = await requireVmCredentialBrowserAuthority(this.options.authService, params);
    const credential = await credentialVault.getMetadata({
      actorUserId: params.userId,
      userId: params.userId,
    });
    const expectedCredentialRevision = credential?.revision ?? null;
    if (!settings.allocation) {
      throw new EmployeeExecutionHttpError(409, "development VM is not assigned");
    }
    if (
      settings.targetRevision !== params.expectedRevision ||
      settings.allocation.id !== params.expectedAllocationId ||
      (credential?.revision ?? 0) !== params.expectedCredentialRevision
    ) {
      throw new EmployeeExecutionHttpError(
        409,
        "VM credential or work location changed; reload and retry",
      );
    }
    if (!params.password || Buffer.byteLength(params.password, "utf8") > 4 * 1024) {
      throw new EmployeeExecutionHttpError(400, "AD password is required");
    }
    const grant = credentialBroker.issueTransient(params.password, async () => {
      await this.assertCurrentAssignment(params.userId, params.agentId, settings);
      const current = await credentialVault.getMetadata({
        actorUserId: params.userId,
        userId: params.userId,
      });
      if ((current?.revision ?? null) !== expectedCredentialRevision) {
        throw new EmployeeExecutionHttpError(409, "VM credential changed; reload and retry");
      }
      await requireVmCredentialBrowserAuthority(this.options.authService, params, authority);
    });
    let connection: ConnectionTestResult;
    try {
      connection = connectionTestResult(
        await this.options.adminRpc.call("platformclaw-execution.testConnection", {
          agentId: params.agentId,
          credentialBrokerAddress: credentialBroker.address,
          credentialGrantToken: grant.token,
        }),
      );
    } catch (error) {
      if (isVmAuthenticationFailure(error)) {
        throw new EmployeeExecutionHttpError(422, "AD password was not accepted");
      }
      throw error;
    } finally {
      credentialBroker.revoke(grant.token);
    }
    if (
      connection.allocationId !== settings.allocation.id ||
      connection.targetRevision !== settings.targetRevision
    ) {
      throw new EmployeeExecutionHttpError(409, "development VM changed during authentication");
    }
    await requireVmCredentialBrowserAuthority(this.options.authService, params, authority);
    const checkedAt = this.now();
    await this.options.store.commitPersonalVmCredential({
      actorUserId: params.userId,
      agentId: params.agentId,
      expectedBindingId: authority.binding.id,
      expectedSessionId: authority.session.id,
      expectedCredentialRevision,
      expectedAllocationId: connection.allocationId,
      expectedTargetRevision: connection.targetRevision,
      credentialEnvelope: credentialVault.sealForStorage(params.userId, params.password),
      checkedAt,
      remoteHomeDir: connection.remoteHomeDir,
      remoteWorkspaceDir: connection.remoteWorkspaceDir,
    });
    await this.options.closeTerminalForAgent?.(params.agentId, "credential_replaced");
    await this.options.onVmCredentialStateChanged?.({
      agentId: params.agentId,
      allocationId: connection.allocationId,
      targetRevision: connection.targetRevision,
      credentialRevision: (expectedCredentialRevision ?? 0) + 1,
      status: "current",
    });
    return await this.getSettings(params.userId, params.agentId);
  }

  async testStoredCredential(userId: string, agentId: string) {
    return await this.withConnectionAttempt(agentId, async () => {
      return await this.testStoredCredentialLocked(userId, agentId);
    });
  }

  private async testStoredCredentialLocked(userId: string, agentId: string) {
    const { credentialBroker, credentialVault } = this.requireCredentialRuntime();
    const settings = await this.requireOwnedSettings(userId, agentId);
    const expectedAllocationId = settings.allocation?.id;
    if (!expectedAllocationId) {
      throw new EmployeeExecutionHttpError(409, "development VM is not assigned");
    }
    const credential = await credentialVault.getMetadata({ actorUserId: userId, userId });
    if (!credential || credential.status !== "current") {
      throw new EmployeeExecutionHttpError(409, "AD password requires an update");
    }
    const grant = credentialBroker.issueForUser(userId, async () => {
      await this.assertCurrentAssignment(userId, agentId, settings);
      const current = await credentialVault.getMetadata({ actorUserId: userId, userId });
      if (current?.revision !== credential.revision || current.status !== "current") {
        throw new EmployeeExecutionHttpError(409, "VM credential changed; reload and retry");
      }
    });
    let rawConnection: unknown;
    try {
      rawConnection = await this.options.adminRpc.call("platformclaw-execution.testConnection", {
        agentId,
        credentialBrokerAddress: credentialBroker.address,
        credentialGrantToken: grant.token,
      });
    } catch (error) {
      const failureKind = vmConnectionFailureKind(error);
      if (isVmAuthenticationFailure(error)) {
        const change = {
          agentId,
          allocationId: expectedAllocationId,
          targetRevision: settings.targetRevision,
          credentialRevision: credential.revision,
        };
        const result = await this.options.store.recordVmAuthenticationFailure({
          ...change,
          failedAt: this.now(),
        });
        if (result.recorded) {
          await this.options.onVmCredentialStateChanged?.({ ...change, status: "update_required" });
        }
      } else if (failureKind) {
        await this.options.store.recordVmConnectionResult({
          actorUserId: userId,
          agentId,
          expectedAllocationId,
          expectedTargetRevision: settings.targetRevision,
          expectedCredentialRevision: credential.revision,
          checkedAt: this.now(),
          result: { status: "connection_required", failureCode: failureKind },
        });
        await this.options.closeTerminalForAgent?.(agentId, "credential_rejected");
      }
      throw error;
    } finally {
      credentialBroker.revoke(grant.token);
    }
    const connection = connectionTestResult(rawConnection);
    await this.options.store.recordVmConnectionResult({
      actorUserId: userId,
      agentId,
      expectedAllocationId: connection.allocationId,
      expectedTargetRevision: connection.targetRevision,
      expectedCredentialRevision: credential.revision,
      checkedAt: this.now(),
      result: { status: "ready", ...connection },
    });
    return await this.getSettings(userId, agentId);
  }

  async changeTarget(params: {
    userId: string;
    agentId: string;
    target: "platform_server" | "assigned_vm";
    expectedRevision: number;
    connectionId?: string;
  }) {
    this.assertNoConnectionAttempt(params.agentId);
    const settings = await this.requireOwnedSettings(params.userId, params.agentId);
    if (settings.targetRevision !== params.expectedRevision) {
      throw new EmployeeExecutionHttpError(409, "work location changed; reload and retry");
    }
    if (params.target === "assigned_vm" && params.connectionId) {
      return await this.withConnectionAttempt(
        params.agentId,
        async () => {
          const { credentialBroker, credentialVault } = this.requireCredentialRuntime();
          const saved = await this.options.store.getSavedVmConnectionCredential({
            actorUserId: params.userId,
            agentId: params.agentId,
            connectionId: params.connectionId!,
          });
          const candidate = saved.candidate;
          const secret = credentialVault.openSavedCredential(
            params.userId,
            saved.credentialEnvelope,
          );
          let grant;
          try {
            grant = credentialBroker.issueTransient(secret, async () => {
              const current = await this.options.store.getSavedVmConnectionCredential({
                actorUserId: params.userId,
                agentId: params.agentId,
                connectionId: saved.connection.id,
              });
              if (current.connection.revision !== saved.connection.revision) {
                throw new EmployeeExecutionHttpError(409, "saved VM changed; reload and retry");
              }
              assertCurrentVmCandidate(candidate, current.candidate);
            });
          } finally {
            secret.fill(0);
          }
          try {
            const result = connectionTestResult(
              await this.options.adminRpc.call("platformclaw-execution.testCandidateConnection", {
                target: { ...candidate, remoteHomeDir: "/", remoteWorkspaceDir: "/" },
                credentialBrokerAddress: credentialBroker.address,
                credentialGrantToken: grant.token,
              }),
            );
            if (
              result.allocationId !== candidate.allocationId ||
              result.targetRevision !== params.expectedRevision ||
              result.remoteHomeDir !== saved.connection.remoteHomeDir ||
              result.remoteWorkspaceDir !== saved.connection.remoteWorkspaceDir
            ) {
              throw new EmployeeExecutionHttpError(
                409,
                "development VM identity changed; reconnect this VM",
              );
            }
          } catch (error) {
            if (isVmAuthenticationFailure(error)) {
              await this.options.store.markSavedVmConnectionUpdateRequired({
                actorUserId: params.userId,
                agentId: params.agentId,
                connectionId: saved.connection.id,
                expectedConnectionRevision: saved.connection.revision,
                failedAt: this.now(),
              });
              throw new EmployeeExecutionHttpError(
                422,
                "AD password was not accepted; reconnect this VM",
              );
            }
            throw error;
          } finally {
            credentialBroker.revoke(grant.token);
          }
          await this.options.adminRpc.call("platformclaw-execution.changeTarget", {
            agentId: params.agentId,
            target: "assigned_vm",
            connectionId: saved.connection.id,
            expectedConnectionRevision: saved.connection.revision,
            expectedRevision: params.expectedRevision,
          });
          await this.options.closeTerminalForAgent?.(params.agentId, "work_location_changed");
          return await this.getSettings(params.userId, params.agentId);
        },
        "saved",
      );
    }
    if (params.target === "assigned_vm") {
      throw new EmployeeExecutionHttpError(
        409,
        "reload Work location and select a saved VM to verify its connection",
      );
    }
    this.assertNoConnectionAttempt(params.agentId);
    await this.options.adminRpc.call("platformclaw-execution.changeTarget", {
      agentId: params.agentId,
      target: params.target,
      expectedRevision: params.expectedRevision,
    });
    await this.options.closeTerminalForAgent?.(params.agentId, "work_location_changed");
    return await this.getSettings(params.userId, params.agentId);
  }

  async saveCodingAgent(params: {
    userId: string;
    agentId: string;
    expectedRevision: number;
    configuration: CodingAgentConfiguration;
  }) {
    const settings = await this.requireOwnedSettings(params.userId, params.agentId);
    if (!settings.allocation || settings.targetRevision !== params.expectedRevision) {
      throw new EmployeeExecutionHttpError(
        409,
        "development VM is not ready or changed; reload and retry",
      );
    }
    await this.options.store.setPersonalCodingAgent({
      actorUserId: params.userId,
      agentId: params.agentId,
      expectedRevision: params.expectedRevision,
      configuration: params.configuration,
      updatedAt: this.now(),
    });
    return await this.getSettings(params.userId, params.agentId);
  }

  async detectCodingAgent(params: {
    userId: string;
    agentId: string;
    agent: CodingAgentId;
    expectedRevision: number;
  }): Promise<CodingAgentProbeResult> {
    const settings = await this.requireOwnedSettings(params.userId, params.agentId);
    if (
      settings.allocation?.status !== "ready" ||
      settings.targetRevision !== params.expectedRevision
    ) {
      throw new EmployeeExecutionHttpError(
        409,
        "development VM is not ready or changed; reload and retry",
      );
    }
    const result = parseCodingAgentVmProbeResult(
      await this.options.adminRpc.call("platformclaw-execution.detectCodingAgent", {
        agentId: params.agentId,
        agent: params.agent,
        expectedRevision: params.expectedRevision,
      }),
      params.agent,
    );
    await this.assertCurrentProbeTarget(params, settings, result);
    return publicCodingAgentProbe(result);
  }

  async checkCodingAgent(params: {
    userId: string;
    agentId: string;
    configuration: CodingAgentConfiguration;
    expectedRevision: number;
  }): Promise<CodingAgentProbeResult> {
    const settings = await this.requireOwnedSettings(params.userId, params.agentId);
    if (
      settings.allocation?.status !== "ready" ||
      settings.targetRevision !== params.expectedRevision
    ) {
      throw new EmployeeExecutionHttpError(
        409,
        "development VM is not ready or changed; reload and retry",
      );
    }
    const result = parseCodingAgentVmProbeResult(
      await this.options.adminRpc.call("platformclaw-execution.checkCodingAgent", {
        agentId: params.agentId,
        configuration: params.configuration,
        expectedRevision: params.expectedRevision,
      }),
      params.configuration.agent,
    );
    await this.assertCurrentProbeTarget(params, settings, result);
    const current = await this.requireOwnedSettings(params.userId, params.agentId);
    const saved = current.codingAgents.find(
      (entry) => entry.configuration.agent === params.configuration.agent,
    );
    if (
      saved?.hasSavedConfiguration &&
      JSON.stringify(saved.configuration) === JSON.stringify(params.configuration)
    ) {
      await this.options.store.recordPersonalCodingAgentCheck({
        actorUserId: params.userId,
        agentId: params.agentId,
        expectedRevision: params.expectedRevision,
        configuration: params.configuration,
        result: {
          agent: result.agent,
          checkedAt: this.now(),
          ...(result.executablePath ? { executablePath: result.executablePath } : {}),
          ...(result.reportedVersion ? { reportedVersion: result.reportedVersion } : {}),
          diagnostics: result.diagnostics,
        },
      });
    }
    return publicCodingAgentProbe(result);
  }

  private async assertCurrentProbeTarget(
    params: { userId: string; agentId: string; expectedRevision: number },
    settings: PersonalExecutionSettings,
    result: { allocationId: string; targetRevision: number },
  ): Promise<void> {
    const current = await this.requireOwnedSettings(params.userId, params.agentId);
    if (
      result.allocationId !== settings.allocation?.id ||
      result.targetRevision !== params.expectedRevision ||
      current.targetRevision !== params.expectedRevision ||
      current.allocation?.id !== settings.allocation?.id ||
      current.allocation.status !== "ready"
    ) {
      throw new EmployeeExecutionHttpError(
        409,
        "development VM changed during coding agent operation; reload and retry",
      );
    }
  }

  private async assertCurrentAssignment(
    userId: string,
    agentId: string,
    expected: PersonalExecutionSettings,
  ): Promise<void> {
    const current = await this.requireOwnedSettings(userId, agentId);
    if (
      !expected.allocation ||
      current.allocation?.id !== expected.allocation.id ||
      current.targetRevision !== expected.targetRevision
    ) {
      throw new EmployeeExecutionHttpError(
        409,
        "development VM changed before authentication; reload and retry",
      );
    }
  }

  private async requireOwnedSettings(
    userId: string,
    agentId: string,
  ): Promise<PersonalExecutionSettings> {
    const settings = await this.options.store.getPersonalExecutionSettings(agentId);
    if (!settings || settings.userId !== userId) {
      throw new EmployeeExecutionHttpError(409, "personal execution settings are unavailable");
    }
    return settings;
  }

  private requireCredentialRuntime() {
    if (!this.options.credentialBroker || !this.options.credentialVault) {
      throw new Error("credential service is unavailable");
    }
    return {
      credentialBroker: this.options.credentialBroker,
      credentialVault: this.options.credentialVault,
    };
  }

  private async withConnectionAttempt<T>(
    agentId: string,
    run: () => Promise<T>,
    source: "supplied" | "saved" = "supplied",
  ): Promise<T> {
    this.assertNoConnectionAttempt(agentId);
    // Saved switches cannot guess passwords; failed authentication marks that
    // registration for reauthentication instead of rate-limiting normal navigation.
    if (source === "supplied") {
      const now = this.now();
      const recent = (this.connectionAttempts.get(agentId) ?? []).filter(
        (attemptedAt) => now - attemptedAt < CONNECTION_ATTEMPT_WINDOW_MS,
      );
      if (recent.length >= CONNECTION_ATTEMPT_LIMIT) {
        throw new EmployeeExecutionHttpError(429, "too many connection attempts; try again later");
      }
      recent.push(now);
      this.connectionAttempts.set(agentId, recent);
    }
    this.activeConnectionTests.add(agentId);
    try {
      return await run();
    } finally {
      this.activeConnectionTests.delete(agentId);
    }
  }

  private assertNoConnectionAttempt(agentId: string): void {
    if (this.isConnectionAttemptActive(agentId)) {
      throw new EmployeeExecutionHttpError(409, "a connection test is already in progress");
    }
  }

  private project(
    settings: PersonalExecutionSettings,
    credentialStatus: string,
    catalog: { accountId: string; hosts: Array<{ id: string; label: string }> },
  ) {
    return {
      activeTarget: settings.activeTarget,
      targetRevision: settings.targetRevision,
      credentialStatus,
      accountId: catalog.accountId,
      availableVms: catalog.hosts,
      ...(settings.allocation ? { assignment: settings.allocation } : {}),
      codingAgents: settings.codingAgents,
    };
  }
}
