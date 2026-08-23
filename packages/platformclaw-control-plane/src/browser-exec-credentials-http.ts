import type { IncomingMessage, ServerResponse } from "node:http";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import type { ExecCredentialService } from "./exec-credential-service.js";

export const PLATFORMCLAW_EXEC_CREDENTIALS_PATH = "/platformclaw/api/exec-credentials";
export const PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_PATH = "/platformclaw/api/admin/exec-credentials";

const BODY_LIMIT_BYTES = 64 * 1024;

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
  if (!auth) {
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
          : await options.service.snapshot(auth.user.id),
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
    const result = admin
      ? body.action === "add"
        ? await options.service.addDefinition(auth.user.id, body.envName)
        : body.action === "remove"
          ? await options.service.removeDefinition(auth.user.id, body.envName)
          : null
      : body.action === "replace" && typeof body.value === "string"
        ? await options.service.replace(auth.user.id, body.envName, body.value)
        : body.action === "remove"
          ? await options.service.remove(auth.user.id, body.envName)
          : null;
    if (!result) {
      throw new ControlPlaneStateError("invalid credential action");
    }
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, error instanceof ControlPlaneAuthorizationError ? 403 : 400, {
      error: error instanceof Error ? error.message : "request failed",
    });
  }
  return true;
}
