import type { IncomingMessage, ServerResponse } from "node:http";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type { BrowserGatewayRpc } from "./browser-gateway-contracts.js";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
} from "./contracts.js";
import type { SqliteKnoxSpaceStore } from "./sqlite-knox-space.js";
import { spaceText } from "./sqlite-spaces.js";

const PLATFORMCLAW_KNOX_SPACE_ADMIN_PATH = "/platformclaw/api/admin/knox-space-bindings";

export class KnoxSpaceAdministrationService {
  constructor(
    private readonly auth: BrowserAuthService,
    private readonly store: SqliteKnoxSpaceStore,
    private readonly gateway: BrowserGatewayRpc,
  ) {}

  async authenticate(token: string) {
    return this.auth.authenticateToken(token);
  }

  snapshot(actorUserId: string) {
    return {
      bindings: this.store.list(actorUserId),
      admissions: this.store.admissions(actorUserId),
    };
  }

  async mutate(actorUserId: string, body: Record<string, unknown>) {
    if (body.action === "retry-cancellation") {
      await this.cancelRevoked(actorUserId);
      return this.snapshot(actorUserId);
    }
    if (body.action !== "connect" && body.action !== "disconnect") {
      throw new ControlPlaneStateError("Invalid connection action");
    }
    if (!Number.isSafeInteger(body.expectedGeneration) || (body.expectedGeneration as number) < 0) {
      throw new ControlPlaneStateError("Expected connection generation required");
    }
    const connection = this.store.manage(actorUserId, {
      accountId: spaceText(body.accountId, "Knox account id", 128).trim(),
      roomId: spaceText(body.roomId, "Knox room id", 256).trim(),
      expectedGeneration: body.expectedGeneration as number,
      action: body.action,
      ...(body.action === "connect"
        ? {
            spaceId: spaceText(body.spaceId, "Space id", 128),
            pageId: spaceText(body.pageId, "page id", 128),
          }
        : {}),
    });
    await this.cancelRevoked(actorUserId);
    return { connection, ...this.snapshot(actorUserId) };
  }

  private async cancelRevoked(actorUserId: string) {
    for (;;) {
      const pending = this.store.pendingCancellations(actorUserId);
      if (!pending.length) {
        return;
      }
      await Promise.all(
        pending.slice(0, 8).map(async (receipt) => {
          const route = JSON.parse(
            receipt.result_json,
          ) as import("./knox-space-contracts.js").KnoxSelfSpaceResolution;
          if (route.status !== "resolved") {
            throw new ControlPlaneStateError("Cancellation receipt unavailable");
          }
          const result = await this.gateway.request("chat.abort", {
            agentId: route.agentId,
            sessionKey: route.sessionKey,
            runId: `knox-my:${receipt.id}`,
          });
          if (
            !result ||
            typeof result !== "object" ||
            !("ok" in result) ||
            result.ok !== true ||
            !("aborted" in result) ||
            typeof result.aborted !== "boolean"
          ) {
            throw new ControlPlaneStateError(
              "Connection changed; cancellation pending. Retry cancellation",
            );
          }
          this.store.acknowledgeCancellation(receipt.id);
        }),
      );
    }
  }
}

function send(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

export async function handleKnoxSpaceAdministrationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    service: KnoxSpaceAdministrationService;
    readJsonBody: JsonBodyReader;
    isMutationOriginAllowed(req: IncomingMessage): boolean;
  },
): Promise<boolean> {
  if (new URL(req.url ?? "/", "http://localhost").pathname !== PLATFORMCLAW_KNOX_SPACE_ADMIN_PATH) {
    return false;
  }
  const token = readPlatformClawSessionCookie(req);
  const auth = token ? await options.service.authenticate(token) : undefined;
  if (!auth || auth.status !== "active") {
    send(res, 401, { error: "authentication required" });
    return true;
  }
  if (auth.user.globalRole !== "admin") {
    send(res, 403, { error: "administrator access required" });
    return true;
  }
  try {
    if (req.method === "GET") {
      send(res, 200, options.service.snapshot(auth.user.id));
    } else if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      send(res, 405, { error: "method_not_allowed" });
    } else if (!options.isMutationOriginAllowed(req)) {
      send(res, 403, { error: "origin not allowed" });
    } else {
      const body = await options.readJsonBody(req, 8 * 1024);
      if (!body.ok || !body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
        send(res, 400, { error: "invalid request body" });
      } else {
        send(
          res,
          200,
          await options.service.mutate(auth.user.id, body.value as Record<string, unknown>),
        );
      }
    }
  } catch (error) {
    const status =
      error instanceof ControlPlaneAuthorizationError
        ? 403
        : error instanceof ControlPlaneConflictError
          ? 409
          : error instanceof ControlPlaneStateError
            ? 400
            : 503;
    send(res, status, {
      error: status === 503 ? "Room connection unavailable" : (error as Error).message,
    });
  }
  return true;
}
