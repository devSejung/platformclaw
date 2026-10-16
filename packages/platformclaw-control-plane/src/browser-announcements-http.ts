import type { IncomingMessage, ServerResponse } from "node:http";
import { ANNOUNCEMENTS_ADMIN_PATH, ANNOUNCEMENTS_PATH } from "./announcement-contracts.js";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
} from "./contracts.js";
import type { SqliteAnnouncementStore } from "./sqlite-announcements.js";

export class BrowserAnnouncementService {
  private readonly listeners = new Set<() => void>();
  constructor(
    readonly auth: BrowserAuthService,
    readonly store: SqliteAnnouncementStore,
    readonly now: () => number = Date.now,
  ) {}
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  changed() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export async function handlePlatformClawAnnouncementRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    service: BrowserAnnouncementService;
    readJsonBody: JsonBodyReader;
    isMutationOriginAllowed(req: IncomingMessage): boolean;
  },
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const seen = path === `${ANNOUNCEMENTS_PATH}/seen`;
  if (path !== ANNOUNCEMENTS_PATH && path !== ANNOUNCEMENTS_ADMIN_PATH && !seen) {
    return false;
  }
  const send = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  };
  try {
    const token = readPlatformClawSessionCookie(req);
    // Background notice refreshes must not extend an idle browser session.
    const auth = token ? await options.service.auth.authenticateToken(token, false) : null;
    if (auth?.status !== "active") {
      send(401, { error: "authentication required" });
      return true;
    }
    const admin = path === ANNOUNCEMENTS_ADMIN_PATH;
    if (admin && auth.user.globalRole !== "admin") {
      send(403, { error: "administrator access required" });
      return true;
    }
    const method = req.method ?? "GET";
    if (method === "GET" && !seen) {
      send(
        200,
        admin
          ? options.service.store.administration(auth.user.id, options.service.now())
          : options.service.store.snapshot(options.service.now()),
      );
    } else if (method === "POST" && (admin || seen)) {
      if (!options.isMutationOriginAllowed(req)) {
        send(403, { error: "origin not allowed" });
        return true;
      }
      const read = await options.readJsonBody(req, 40 * 1024);
      if (!read.ok || !read.value || typeof read.value !== "object" || Array.isArray(read.value)) {
        send(400, { error: read.ok ? "invalid request body" : read.error });
        return true;
      }
      const input = read.value as Record<string, unknown>;
      if (seen) {
        send(200, {
          show: options.service.store.claimPresentation(
            auth.user.id,
            input.id,
            input.revision,
            options.service.now(),
          ),
        });
        return true;
      }
      const result = options.service.store.mutate(auth.user.id, input, options.service.now());
      options.service.changed();
      send(200, result);
    } else {
      res.setHeader("Allow", seen ? "POST" : admin ? "GET, POST" : "GET");
      send(405, { error: "method not allowed" });
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
    send(status, {
      error: status === 503 ? "Announcement service unavailable" : (error as Error).message,
    });
  }
  return true;
}
