import type { IncomingMessage, ServerResponse } from "node:http";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import { handleCodingAgentRouteOperation } from "./browser-execution-coding-agent-route.js";
import {
  EmployeeExecutionService,
  EmployeeExecutionHttpError,
  isVmAuthenticationFailure,
} from "./browser-execution-service.js";
import { ControlPlaneConflictError } from "./contracts.js";
import { GatewayAdminRpcError } from "./gateway-admin-rpc-client.js";
export { EmployeeExecutionService } from "./browser-execution-service.js";

const PLATFORMCLAW_EXECUTION_SETTINGS_PATH = "/platformclaw/api/execution";
const PLATFORMCLAW_EXECUTION_CREDENTIAL_PATH = "/platformclaw/api/execution/credential";
const PLATFORMCLAW_EXECUTION_TEST_PATH = "/platformclaw/api/execution/test";
export const PLATFORMCLAW_EXECUTION_TARGET_PATH = "/platformclaw/api/execution/target";
const PLATFORMCLAW_EXECUTION_SELECTION_PATH = "/platformclaw/api/execution/selection";
const PLATFORMCLAW_EXECUTION_RELEASE_PATH = "/platformclaw/api/execution/release";
const PLATFORMCLAW_EXECUTION_CODING_AGENT_PATH = "/platformclaw/api/execution/coding-agent";

const EXECUTION_BODY_LIMIT_BYTES = 24 * 1024;

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
    pathname !== PLATFORMCLAW_EXECUTION_RELEASE_PATH &&
    pathname !== PLATFORMCLAW_EXECUTION_CODING_AGENT_PATH
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
    const read = await options.readJsonBody(req, EXECUTION_BODY_LIMIT_BYTES);
    const body = read.ok ? objectBody(read.value) : null;
    if (!body) {
      sendJson(res, 400, { error: read.ok ? "invalid request" : read.error });
      return true;
    }
    if (pathname === PLATFORMCLAW_EXECUTION_RELEASE_PATH) {
      if (typeof body.connectionId !== "string" || !body.connectionId.trim()) {
        sendJson(res, 400, { error: "saved VM connection is required" });
        return true;
      }
      sendJson(
        res,
        200,
        await options.service.releaseVm(auth.user.id, auth.binding.agentId, body.connectionId),
      );
      return true;
    }
    if (pathname === PLATFORMCLAW_EXECUTION_CREDENTIAL_PATH) {
      if (
        typeof body.expectedRevision !== "number" ||
        !Number.isSafeInteger(body.expectedRevision) ||
        body.expectedRevision < 0 ||
        typeof body.expectedCredentialRevision !== "number" ||
        !Number.isSafeInteger(body.expectedCredentialRevision) ||
        body.expectedCredentialRevision < 0 ||
        typeof body.expectedAllocationId !== "string" ||
        !body.expectedAllocationId.trim() ||
        body.expectedAllocationId.length > 256
      ) {
        sendJson(res, 400, { error: "current VM credential and work location are required" });
        return true;
      }
      const password = typeof body.password === "string" ? body.password : "";
      sendJson(
        res,
        200,
        await options.service.registerCredential({
          userId: auth.user.id,
          agentId: auth.binding.agentId,
          password,
          sessionToken: token ?? "",
          expectedRevision: body.expectedRevision,
          expectedCredentialRevision: body.expectedCredentialRevision,
          expectedAllocationId: body.expectedAllocationId,
        }),
      );
      return true;
    }
    if (pathname === PLATFORMCLAW_EXECUTION_SELECTION_PATH) {
      if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) {
        sendJson(res, 400, { error: "work location revision is required" });
        return true;
      }
      sendJson(
        res,
        200,
        await options.service.selectVm({
          userId: auth.user.id,
          agentId: auth.binding.agentId,
          vmHostId: typeof body.vmHostId === "string" ? body.vmHostId : "",
          linuxAccount: typeof body.linuxAccount === "string" ? body.linuxAccount : "",
          password: typeof body.password === "string" ? body.password : "",
          expectedRevision: body.expectedRevision as number,
        }),
      );
      return true;
    }
    if (pathname === PLATFORMCLAW_EXECUTION_CODING_AGENT_PATH) {
      const result = await handleCodingAgentRouteOperation({
        service: options.service,
        body,
        userId: auth.user.id,
        agentId: auth.binding.agentId,
      });
      sendJson(res, result.status, result.body);
      return true;
    }
    const target = body.target;
    const expectedRevision = body.expectedRevision;
    const connectionId = body.connectionId;
    if (
      (target !== "platform_server" && target !== "assigned_vm") ||
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      (connectionId !== undefined &&
        (target !== "assigned_vm" ||
          typeof connectionId !== "string" ||
          !connectionId.trim() ||
          connectionId.length > 256))
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
        ...(typeof connectionId === "string" ? { connectionId } : {}),
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
