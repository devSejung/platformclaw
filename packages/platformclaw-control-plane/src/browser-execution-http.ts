import type { IncomingMessage, ServerResponse } from "node:http";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import { ControlPlaneConflictError, type ControlPlaneStore } from "./contracts.js";
import type {
  ControlPlaneAtomicVmCredentialStore,
  ControlPlaneEmployeeExecutionStore,
  ControlPlaneVmSelfServiceStore,
  PersonalExecutionSettings,
} from "./execution-contracts.js";
import { GatewayAdminRpcError, type GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import type { SshCredentialBroker } from "./ssh-credential-broker.js";
import type { SshCredentialVault } from "./ssh-credential-vault.js";

const PLATFORMCLAW_EXECUTION_SETTINGS_PATH = "/platformclaw/api/execution";
const PLATFORMCLAW_EXECUTION_CREDENTIAL_PATH = "/platformclaw/api/execution/credential";
const PLATFORMCLAW_EXECUTION_TEST_PATH = "/platformclaw/api/execution/test";
export const PLATFORMCLAW_EXECUTION_TARGET_PATH = "/platformclaw/api/execution/target";
const PLATFORMCLAW_EXECUTION_SELECTION_PATH = "/platformclaw/api/execution/selection";
const PLATFORMCLAW_EXECUTION_RELEASE_PATH = "/platformclaw/api/execution/release";

const EXECUTION_BODY_LIMIT_BYTES = 8 * 1024;
const CONNECTION_ATTEMPT_WINDOW_MS = 5 * 60_000;
const CONNECTION_ATTEMPT_LIMIT = 5;

class EmployeeExecutionHttpError extends Error {
  constructor(
    readonly statusCode: 400 | 409 | 422 | 429,
    message: string,
  ) {
    super(message);
    this.name = "EmployeeExecutionHttpError";
  }
}

type EmployeeExecutionStore = ControlPlaneStore &
  ControlPlaneEmployeeExecutionStore &
  ControlPlaneVmSelfServiceStore &
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
  now?: () => number;
};

type ConnectionTestResult = {
  allocationId: string;
  targetRevision: number;
  remoteHomeDir: string;
  remoteWorkspaceDir: string;
};

function connectionTestResult(value: unknown): ConnectionTestResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("development VM returned an invalid connection result");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.remoteHomeDir !== "string" ||
    !result.remoteHomeDir.startsWith("/") ||
    typeof result.remoteWorkspaceDir !== "string" ||
    !result.remoteWorkspaceDir.startsWith(`${result.remoteHomeDir}/`) ||
    typeof result.allocationId !== "string" ||
    !result.allocationId.trim() ||
    typeof result.targetRevision !== "number" ||
    !Number.isSafeInteger(result.targetRevision) ||
    result.targetRevision < 0
  ) {
    throw new Error("development VM returned an invalid connection result");
  }
  return {
    allocationId: result.allocationId,
    targetRevision: result.targetRevision,
    remoteHomeDir: result.remoteHomeDir,
    remoteWorkspaceDir: result.remoteWorkspaceDir,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.end(JSON.stringify(body));
}

function methodNotAllowed(res: ServerResponse, allowed: string): void {
  res.statusCode = 405;
  res.setHeader("Allow", allowed);
  res.end("Method Not Allowed");
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function vmConnectionFailureKind(error: unknown): string | null {
  if (!(error instanceof GatewayAdminRpcError)) {
    return null;
  }
  const details = error.details;
  const kind =
    details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>).kind
      : undefined;
  return typeof kind === "string" && kind.startsWith("vm_") ? kind : null;
}

function isVmAuthenticationFailure(error: unknown): boolean {
  return vmConnectionFailureKind(error) === "vm_authentication_failed";
}

export class EmployeeExecutionService {
  private readonly now: () => number;
  private readonly activeConnectionTests = new Set<string>();
  private readonly connectionAttempts = new Map<string, number[]>();

  constructor(private readonly options: EmployeeExecutionServiceOptions) {
    this.now = options.now ?? Date.now;
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
    return this.project(settings, credential?.status ?? "missing", catalog);
  }

  async selectVm(params: {
    userId: string;
    agentId: string;
    vmHostId: string;
    linuxAccount: string;
    password: string;
  }) {
    return await this.withConnectionAttempt(params.agentId, async () => {
      const { credentialBroker, credentialVault } = this.requireCredentialRuntime();
      const settings = await this.requireOwnedSettings(params.userId, params.agentId);
      if (settings.activeTarget !== "platform_server") {
        throw new EmployeeExecutionHttpError(
          409,
          "switch to the Basic workspace before changing development VM",
        );
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
      const grant = credentialBroker.issueTransient(params.password);
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
      const replacedAt = this.now();
      await this.options.store.commitPersonalVmSelection({
        actorUserId: params.userId,
        agentId: params.agentId,
        vmHostId: params.vmHostId,
        linuxAccount: candidate.linuxAccount,
        remoteHomeDir: connection.remoteHomeDir,
        remoteWorkspaceDir: connection.remoteWorkspaceDir,
        credentialEnvelope: credentialVault.sealForStorage(params.userId, params.password),
        committedAt: replacedAt,
      });
      await this.options.closeTerminalForAgent?.(params.agentId, "allocation_replaced");
      return await this.getSettings(params.userId, params.agentId);
    });
  }

  async releaseVm(userId: string, agentId: string) {
    const settings = await this.requireOwnedSettings(userId, agentId);
    if (settings.allocation && settings.activeTarget !== "platform_server") {
      throw new EmployeeExecutionHttpError(
        409,
        "switch to the Basic workspace before releasing development VM",
      );
    }
    const releasedAt = this.now();
    await this.options.store.releasePersonalVmAccess({
      actorUserId: userId,
      agentId,
      releasedAt,
    });
    await this.options.closeTerminalForAgent?.(agentId, "allocation_released");
    return await this.getSettings(userId, agentId);
  }

  async registerCredential(params: { userId: string; agentId: string; password: string }) {
    return await this.withConnectionAttempt(params.agentId, async () => {
      return await this.registerCredentialLocked(params);
    });
  }

  private async registerCredentialLocked(params: {
    userId: string;
    agentId: string;
    password: string;
  }) {
    const { credentialBroker, credentialVault } = this.requireCredentialRuntime();
    await this.requireOwnedSettings(params.userId, params.agentId);
    if (!params.password || Buffer.byteLength(params.password, "utf8") > 4 * 1024) {
      throw new EmployeeExecutionHttpError(400, "AD password is required");
    }
    const grant = credentialBroker.issueTransient(params.password);
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
    const checkedAt = this.now();
    await credentialVault.replace({
      actorUserId: params.userId,
      userId: params.userId,
      password: params.password,
      replacedAt: checkedAt,
    });
    await this.options.closeTerminalForAgent?.(params.agentId, "credential_replaced");
    await this.options.store.recordVmConnectionResult({
      actorUserId: params.userId,
      agentId: params.agentId,
      expectedAllocationId: connection.allocationId,
      expectedTargetRevision: connection.targetRevision,
      checkedAt,
      result: { status: "ready", ...connection },
    });
    return await this.getSettings(params.userId, params.agentId);
  }

  async testStoredCredential(userId: string, agentId: string) {
    return await this.withConnectionAttempt(agentId, async () => {
      return await this.testStoredCredentialLocked(userId, agentId);
    });
  }

  private async testStoredCredentialLocked(userId: string, agentId: string) {
    const { credentialBroker } = this.requireCredentialRuntime();
    const settings = await this.requireOwnedSettings(userId, agentId);
    const expectedAllocationId = settings.allocation?.id;
    if (!expectedAllocationId) {
      throw new EmployeeExecutionHttpError(409, "development VM is not assigned");
    }
    const grant = credentialBroker.issueForUser(userId);
    let rawConnection: unknown;
    try {
      rawConnection = await this.options.adminRpc.call("platformclaw-execution.testConnection", {
        agentId,
        credentialBrokerAddress: credentialBroker.address,
        credentialGrantToken: grant.token,
      });
    } catch (error) {
      const failureKind = vmConnectionFailureKind(error);
      if (failureKind) {
        await this.options.store.recordVmConnectionResult({
          actorUserId: userId,
          agentId,
          expectedAllocationId,
          expectedTargetRevision: settings.targetRevision,
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
  }) {
    const settings = await this.requireOwnedSettings(params.userId, params.agentId);
    if (params.target === "assigned_vm") {
      const credential = await this.options.credentialVault?.getMetadata({
        actorUserId: params.userId,
        userId: params.userId,
      });
      if (credential?.status !== "current" || settings.allocation?.status !== "ready") {
        throw new EmployeeExecutionHttpError(409, "development VM is not ready");
      }
    }
    await this.options.adminRpc.call("platformclaw-execution.changeTarget", {
      agentId: params.agentId,
      target: params.target,
      expectedRevision: params.expectedRevision,
    });
    return await this.getSettings(params.userId, params.agentId);
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

  private async withConnectionAttempt<T>(agentId: string, run: () => Promise<T>): Promise<T> {
    if (this.activeConnectionTests.has(agentId)) {
      throw new EmployeeExecutionHttpError(409, "a connection test is already in progress");
    }
    const now = this.now();
    const recent = (this.connectionAttempts.get(agentId) ?? []).filter(
      (attemptedAt) => now - attemptedAt < CONNECTION_ATTEMPT_WINDOW_MS,
    );
    if (recent.length >= CONNECTION_ATTEMPT_LIMIT) {
      throw new EmployeeExecutionHttpError(429, "too many connection attempts; try again later");
    }
    recent.push(now);
    this.connectionAttempts.set(agentId, recent);
    this.activeConnectionTests.add(agentId);
    try {
      return await run();
    } finally {
      this.activeConnectionTests.delete(agentId);
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
    };
  }
}

export async function handlePlatformClawEmployeeExecutionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    service: EmployeeExecutionService;
    readJsonBody: JsonBodyReader;
    isMutationOriginAllowed(req: IncomingMessage): boolean;
  },
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (
    pathname !== PLATFORMCLAW_EXECUTION_SETTINGS_PATH &&
    pathname !== PLATFORMCLAW_EXECUTION_CREDENTIAL_PATH &&
    pathname !== PLATFORMCLAW_EXECUTION_TEST_PATH &&
    pathname !== PLATFORMCLAW_EXECUTION_TARGET_PATH &&
    pathname !== PLATFORMCLAW_EXECUTION_SELECTION_PATH &&
    pathname !== PLATFORMCLAW_EXECUTION_RELEASE_PATH
  ) {
    return false;
  }
  const token = readPlatformClawSessionCookie(req);
  const auth = token ? await options.service.authenticate(token) : null;
  if (!auth) {
    sendJson(res, 401, { error: "authentication required" });
    return true;
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (pathname === PLATFORMCLAW_EXECUTION_SETTINGS_PATH) {
    if (method !== "GET") {
      methodNotAllowed(res, "GET");
      return true;
    }
    sendJson(res, 200, await options.service.getSettings(auth.user.id, auth.binding.agentId));
    return true;
  }
  if (method !== "POST") {
    methodNotAllowed(res, "POST");
    return true;
  }
  if (!options.isMutationOriginAllowed(req)) {
    sendJson(res, 403, { error: "origin not allowed" });
    return true;
  }
  try {
    if (pathname === PLATFORMCLAW_EXECUTION_TEST_PATH) {
      sendJson(
        res,
        200,
        await options.service.testStoredCredential(auth.user.id, auth.binding.agentId),
      );
      return true;
    }
    if (pathname === PLATFORMCLAW_EXECUTION_RELEASE_PATH) {
      sendJson(res, 200, await options.service.releaseVm(auth.user.id, auth.binding.agentId));
      return true;
    }
    const read = await options.readJsonBody(req, EXECUTION_BODY_LIMIT_BYTES);
    const body = read.ok ? objectBody(read.value) : null;
    if (!body) {
      sendJson(res, 400, { error: read.ok ? "invalid request" : read.error });
      return true;
    }
    if (pathname === PLATFORMCLAW_EXECUTION_CREDENTIAL_PATH) {
      const password = typeof body.password === "string" ? body.password : "";
      sendJson(
        res,
        200,
        await options.service.registerCredential({
          userId: auth.user.id,
          agentId: auth.binding.agentId,
          password,
        }),
      );
      return true;
    }
    if (pathname === PLATFORMCLAW_EXECUTION_SELECTION_PATH) {
      sendJson(
        res,
        200,
        await options.service.selectVm({
          userId: auth.user.id,
          agentId: auth.binding.agentId,
          vmHostId: typeof body.vmHostId === "string" ? body.vmHostId : "",
          linuxAccount: typeof body.linuxAccount === "string" ? body.linuxAccount : "",
          password: typeof body.password === "string" ? body.password : "",
        }),
      );
      return true;
    }
    const target = body.target;
    const expectedRevision = body.expectedRevision;
    if (
      (target !== "platform_server" && target !== "assigned_vm") ||
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    ) {
      sendJson(res, 400, { error: "invalid work location change" });
      return true;
    }
    sendJson(
      res,
      200,
      await options.service.changeTarget({
        userId: auth.user.id,
        agentId: auth.binding.agentId,
        target,
        expectedRevision,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    if (error instanceof EmployeeExecutionHttpError) {
      sendJson(res, error.statusCode, { error: message });
      return true;
    }
    if (isVmAuthenticationFailure(error)) {
      sendJson(res, 422, { error: "AD password was not accepted" });
      return true;
    }
    if (error instanceof GatewayAdminRpcError && error.code === "CONFLICT") {
      sendJson(res, 409, { error: message });
      return true;
    }
    if (error instanceof ControlPlaneConflictError) {
      sendJson(res, 409, { error: message });
      return true;
    }
    sendJson(res, 503, { error: message });
  }
  return true;
}
