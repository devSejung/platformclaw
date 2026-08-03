import type { IncomingMessage, ServerResponse } from "node:http";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
  type ControlPlaneAuditReader,
} from "./contracts.js";
import type {
  ControlPlaneEmployeeExecutionStore,
  ControlPlaneExecutionManagementStore,
  ControlPlaneVmLifecycleStore,
  VmAdministrationSnapshot,
} from "./execution-contracts.js";
import { normalizeVmHostExecutionEnvironment } from "./execution-validation.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import { probeSafeConnectEndpoint, type SafeConnectProbeResult } from "./safeconnect-probe.js";

export const PLATFORMCLAW_VM_ADMIN_PATH = "/platformclaw/api/admin/vm";
const BODY_LIMIT_BYTES = 24 * 1024;
const VM_AUDIT_TARGETS = new Set(["safeconnect-endpoint", "vm-host", "vm-allocation"]);

type VmAdministrationStore = ControlPlaneExecutionManagementStore &
  ControlPlaneEmployeeExecutionStore &
  ControlPlaneVmLifecycleStore &
  ControlPlaneAuditReader;
type VmAdministrationResponse = VmAdministrationSnapshot & {
  auditEvents: Awaited<ReturnType<ControlPlaneAuditReader["listAuditEvents"]>>;
  probe?: SafeConnectProbeResult;
};

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new ControlPlaneStateError(`${name} is required`);
  }
  return value.trim();
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlPlaneStateError("invalid request body");
  }
  return value as Record<string, unknown>;
}

export class VmAdministrationService {
  constructor(
    private readonly options: {
      authService: BrowserAuthService;
      store: VmAdministrationStore;
      adminRpc: GatewayAdminRpc;
      now?: () => number;
      probeEndpoint?: typeof probeSafeConnectEndpoint;
    },
  ) {}

  async authenticate(token: string) {
    const result = await this.options.authService.authenticateToken(token);
    return result.status === "active" ? result : null;
  }

  async snapshot(actorUserId: string): Promise<VmAdministrationResponse> {
    const snapshot = await this.options.store.getVmAdministrationSnapshot(actorUserId);
    const auditEvents = (await this.options.store.listAuditEvents(200))
      .filter((event) => VM_AUDIT_TARGETS.has(event.targetType))
      .slice(0, 100);
    return { ...snapshot, auditEvents };
  }

  async mutate(actorUserId: string, action: string, body: Record<string, unknown>) {
    const now = (this.options.now ?? Date.now)();
    switch (action) {
      case "probe-endpoint": {
        const port = body.port;
        if (typeof port !== "number" || !Number.isSafeInteger(port)) {
          throw new ControlPlaneStateError("port must be an integer");
        }
        const probe = await (this.options.probeEndpoint ?? probeSafeConnectEndpoint)({
          host: stringField(body, "host"),
          port,
        });
        return { ...(await this.snapshot(actorUserId)), probe };
      }
      case "endpoints": {
        const port = body.port;
        if (typeof port !== "number" || !Number.isSafeInteger(port)) {
          throw new ControlPlaneStateError("port must be an integer");
        }
        await this.options.store.createSafeConnectEndpoint({
          actorUserId,
          label: stringField(body, "label"),
          host: stringField(body, "host"),
          port,
          adDomain: stringField(body, "adDomain"),
          createdAt: now,
        });
        break;
      }
      case "update-endpoint": {
        const port = body.port;
        if (typeof port !== "number" || !Number.isSafeInteger(port)) {
          throw new ControlPlaneStateError("port must be an integer");
        }
        await this.options.store.updateSafeConnectEndpoint({
          actorUserId,
          endpointId: stringField(body, "endpointId"),
          label: stringField(body, "label"),
          host: stringField(body, "host"),
          port,
          adDomain: stringField(body, "adDomain"),
          updatedAt: now,
        });
        break;
      }
      case "host-key":
        await this.options.store.approveSafeConnectHostKey({
          actorUserId,
          endpointId: stringField(body, "endpointId"),
          algorithm: stringField(body, "algorithm"),
          publicKey: stringField(body, "publicKey"),
          fingerprint: stringField(body, "fingerprint"),
          approvedAt: now,
        });
        break;
      case "hosts": {
        const executionEnvironment = normalizeVmHostExecutionEnvironment(body.executionEnvironment);
        await this.options.store.createVmHost({
          actorUserId,
          endpointId: stringField(body, "endpointId"),
          label: stringField(body, "label"),
          targetAddress: stringField(body, "targetAddress"),
          ...(executionEnvironment ? { executionEnvironment } : {}),
          createdAt: now,
        });
        break;
      }
      case "disable-endpoint":
        await this.options.store.disableSafeConnectEndpoint({
          actorUserId,
          endpointId: stringField(body, "endpointId"),
          disabledAt: now,
        });
        break;
      case "enable-endpoint":
        await this.options.store.enableSafeConnectEndpoint({
          actorUserId,
          endpointId: stringField(body, "endpointId"),
          enabledAt: now,
        });
        break;
      case "update-host":
        await this.options.store.updateVmHost({
          actorUserId,
          vmHostId: stringField(body, "vmHostId"),
          endpointId: stringField(body, "endpointId"),
          label: stringField(body, "label"),
          targetAddress: stringField(body, "targetAddress"),
          updatedAt: now,
        });
        break;
      case "update-host-execution-environment": {
        const executionEnvironment = normalizeVmHostExecutionEnvironment(body.executionEnvironment);
        await this.options.store.updateVmHostExecutionEnvironment({
          actorUserId,
          vmHostId: stringField(body, "vmHostId"),
          ...(executionEnvironment ? { executionEnvironment } : {}),
          updatedAt: now,
        });
        break;
      }
      case "disable-host":
        await this.options.store.disableVmHost({
          actorUserId,
          vmHostId: stringField(body, "vmHostId"),
          disabledAt: now,
        });
        break;
      case "enable-host":
        await this.options.store.enableVmHost({
          actorUserId,
          vmHostId: stringField(body, "vmHostId"),
          enabledAt: now,
        });
        break;
      case "revoke-allocation": {
        const allocationId = stringField(body, "allocationId");
        const allocation = (
          await this.options.store.getVmAdministrationSnapshot(actorUserId)
        ).allocations.find((candidate) => candidate.id === allocationId);
        if (!allocation) {
          throw new ControlPlaneStateError("active VM assignment is unavailable");
        }
        const settings = await this.options.store.getPersonalExecutionSettings(allocation.agentId);
        if (settings?.activeTarget === "assigned_vm") {
          await this.options.adminRpc.call("platformclaw-execution.changeTarget", {
            agentId: allocation.agentId,
            target: "platform_server",
            expectedRevision: settings.targetRevision,
          });
        }
        await this.options.store.revokeVmAllocationAsAdmin({
          actorUserId,
          allocationId,
          revokedAt: now,
        });
        break;
      }
      default:
        throw new ControlPlaneStateError("unknown VM administration action");
    }
    return await this.snapshot(actorUserId);
  }
}

export async function handlePlatformClawVmAdministrationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    service: VmAdministrationService;
    readJsonBody: JsonBodyReader;
    isMutationOriginAllowed(req: IncomingMessage): boolean;
  },
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname !== PLATFORMCLAW_VM_ADMIN_PATH) {
    return false;
  }
  const token = readPlatformClawSessionCookie(req);
  const auth = token ? await options.service.authenticate(token) : null;
  if (!auth) {
    sendJson(res, 401, { error: "authentication required" });
    return true;
  }
  if (auth.user.globalRole !== "admin") {
    sendJson(res, 403, { error: "administrator access required" });
    return true;
  }
  const method = (req.method ?? "GET").toUpperCase();
  try {
    if (method === "GET") {
      sendJson(res, 200, await options.service.snapshot(auth.user.id));
      return true;
    }
    if (method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, POST");
      res.end("Method Not Allowed");
      return true;
    }
    if (!options.isMutationOriginAllowed(req)) {
      sendJson(res, 403, { error: "origin not allowed" });
      return true;
    }
    const read = await options.readJsonBody(req, BODY_LIMIT_BYTES);
    if (!read.ok) {
      sendJson(res, 400, { error: read.error });
      return true;
    }
    const body = objectBody(read.value);
    sendJson(
      res,
      200,
      await options.service.mutate(auth.user.id, stringField(body, "action"), body),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    const status =
      error instanceof ControlPlaneAuthorizationError
        ? 403
        : error instanceof ControlPlaneConflictError
          ? 409
          : error instanceof ControlPlaneStateError
            ? 400
            : 503;
    sendJson(res, status, { error: message });
  }
  return true;
}
