import type { IncomingMessage, ServerResponse } from "node:http";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
} from "./contracts.js";
import type { ExecCredentialPreconditions } from "./exec-credential-contracts.js";
import type { ExecCredentialService } from "./exec-credential-service.js";

const PLATFORMCLAW_EXEC_CREDENTIALS_PATH = "/platformclaw/api/exec-credentials";
const PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_PATH = "/platformclaw/api/admin/exec-credentials";

const BODY_LIMIT_BYTES = 64 * 1024;

function readExpectedToken(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128) {
    throw new ControlPlaneStateError("invalid credential snapshot");
  }
  return value;
}

function readCredentialPreconditions(body: Record<string, unknown>): ExecCredentialPreconditions {
  return {
    expectedDefinitionToken: readExpectedToken(body.expectedDefinitionToken),
    expectedCredentialToken:
      body.expectedCredentialToken === null
        ? null
        : readExpectedToken(body.expectedCredentialToken),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export async function handlePlatformClawExecCredentialRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    service: ExecCredentialService;
    readJsonBody: JsonBodyReader;
    isMutationOriginAllowed: (req: IncomingMessage) => boolean;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const admin = url.pathname === PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_PATH;
  if (!admin && url.pathname !== PLATFORMCLAW_EXEC_CREDENTIALS_PATH) {
    return false;
  }
  const token = readPlatformClawSessionCookie(req);
  const auth = token ? await options.service.authenticate(token) : null;
  if (!token || !auth) {
    sendJson(res, 401, { error: "authentication required" });
    return true;
  }
  if (req.method === "GET") {
    try {
      sendJson(
        res,
        200,
        admin
          ? await options.service.adminSnapshot(auth.user.id)
          : { ...(await options.service.snapshot(auth.user.id)), accountId: auth.user.accountId },
      );
    } catch (error) {
      sendJson(res, error instanceof ControlPlaneAuthorizationError ? 403 : 400, {
        error: error instanceof Error ? error.message : "request failed",
      });
    }
    return true;
  }
  if (req.method !== "POST" || !options.isMutationOriginAllowed(req)) {
    sendJson(res, req.method === "POST" ? 403 : 405, { error: "request rejected" });
    return true;
  }
  try {
    const read = await options.readJsonBody(req, BODY_LIMIT_BYTES);
    if (!read.ok) {
      sendJson(res, 400, { error: read.error });
      return true;
    }
    const body = asRecord(read.value);
    if (!body || typeof body.action !== "string" || typeof body.envName !== "string") {
      throw new ControlPlaneStateError("invalid request body");
    }
    // Body reads await external I/O. Recheck the session before applying either kind of mutation.
    const currentAuth = await options.service.authenticate(token);
    if (!currentAuth) {
      sendJson(res, 401, { error: "authentication required" });
      return true;
    }
    if (typeof body.expectedAccountId !== "string" || !body.expectedAccountId) {
      throw new ControlPlaneStateError("invalid expected account");
    }
    // Bind admin changes too: another login must not inherit an old tab's intended action.
    if (body.expectedAccountId !== currentAuth.user.accountId) {
      sendJson(res, 409, {
        error: "credential-account-changed",
        code: "credential-account-changed",
      });
      return true;
    }
    const result = admin
      ? body.action === "add"
        ? await options.service.addDefinition(currentAuth.user.id, body.envName)
        : body.action === "remove"
          ? await options.service.removeDefinition(
              currentAuth.user.id,
              body.envName,
              readExpectedToken(body.expectedDefinitionToken),
            )
          : null
      : body.action === "replace" && typeof body.value === "string"
        ? await options.service.replace(
            currentAuth.user.id,
            body.envName,
            body.value,
            readCredentialPreconditions(body),
          )
        : body.action === "remove"
          ? await options.service.remove(
              currentAuth.user.id,
              body.envName,
              readCredentialPreconditions(body),
            )
          : null;
    if (!result) {
      throw new ControlPlaneStateError("invalid credential action");
    }
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(
      res,
      error instanceof ControlPlaneAuthorizationError
        ? 403
        : error instanceof ControlPlaneConflictError
          ? 409
          : 400,
      {
        error: error instanceof Error ? error.message : "request failed",
        ...(error instanceof ControlPlaneConflictError ? { code: error.code } : {}),
      },
    );
  }
  return true;
}
