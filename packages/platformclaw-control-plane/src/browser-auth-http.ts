import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrowserAuthService } from "./browser-auth-service.js";
import { BROWSER_SESSION_POLICY } from "./contracts.js";

export const PLATFORMCLAW_SESSION_COOKIE = "platformclaw_session";
export const PLATFORMCLAW_LOGIN_PATH = "/platformclaw/api/auth/login";
export const PLATFORMCLAW_LOGOUT_PATH = "/platformclaw/api/auth/logout";
export const PLATFORMCLAW_SESSION_PATH = "/platformclaw/api/auth/session";

const LOGIN_BODY_LIMIT_BYTES = 64 * 1024;
const LOGIN_RATE_LIMIT_SCOPE = "platformclaw-browser-login";

export type BrowserLoginRateLimiter = {
  check(
    clientIp: string | undefined,
    scope: string,
  ): {
    allowed: boolean;
    retryAfterMs: number;
  };
  recordFailure(clientIp: string | undefined, scope: string): void;
};

export type JsonBodyReader = (
  req: IncomingMessage,
  maxBytes: number,
) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;

export type BrowserAuthHttpOptions = {
  service: BrowserAuthService;
  readJsonBody: JsonBodyReader;
  clientIp?: string;
  gatewayUrl?: string;
  requestIsSecure: boolean;
  isMutationOriginAllowed(req: IncomingMessage): boolean;
  rateLimiter: BrowserLoginRateLimiter;
};

type LoginBody = {
  identifier?: unknown;
  username?: unknown;
  password?: unknown;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.end(JSON.stringify(body));
}

function appendSetCookie(res: ServerResponse, cookie: string): void {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current, cookie]);
  } else {
    res.setHeader("Set-Cookie", [String(current), cookie]);
  }
}

function serializeSessionCookie(value: string, secure: boolean, clear = false): string {
  const parts = [`${PLATFORMCLAW_SESSION_COOKIE}=${encodeURIComponent(value)}`];
  if (clear) {
    parts.push("Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  } else {
    parts.push(`Max-Age=${Math.floor(BROWSER_SESSION_POLICY.absoluteTimeoutMs / 1000)}`);
  }
  parts.push("Path=/", "HttpOnly", "SameSite=Lax");
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function readPlatformClawSessionCookie(req: IncomingMessage): string | undefined {
  const raw = Array.isArray(req.headers.cookie)
    ? req.headers.cookie.join("; ")
    : (req.headers.cookie ?? "");
  for (const item of raw.split(";")) {
    const [name, ...rest] = item.split("=");
    if (name?.trim() !== PLATFORMCLAW_SESSION_COOKIE) {
      continue;
    }
    const value = rest.join("=").trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function clearSessionCookie(res: ServerResponse, secure: boolean): void {
  appendSetCookie(res, serializeSessionCookie("", secure, true));
}

function methodNotAllowed(res: ServerResponse, allowed: string): void {
  res.statusCode = 405;
  res.setHeader("Allow", allowed);
  res.end("Method Not Allowed");
}

export async function handlePlatformClawBrowserAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: BrowserAuthHttpOptions,
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = (req.method ?? "GET").toUpperCase();

  if (pathname === PLATFORMCLAW_LOGIN_PATH) {
    if (method !== "POST") {
      methodNotAllowed(res, "POST");
      return true;
    }
    if (!options.isMutationOriginAllowed(req)) {
      sendJson(res, 403, { authenticated: false, message: "origin not allowed" });
      return true;
    }
    const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      sendJson(res, 415, { authenticated: false, message: "application/json required" });
      return true;
    }
    const limited = options.rateLimiter.check(options.clientIp, LOGIN_RATE_LIMIT_SCOPE);
    if (limited && !limited.allowed) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))));
      sendJson(res, 429, { authenticated: false, message: "too many sign-in attempts" });
      return true;
    }
    const body = await options.readJsonBody(req, LOGIN_BODY_LIMIT_BYTES);
    if (!body.ok || !body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
      sendJson(res, 400, {
        authenticated: false,
        message: body.ok ? "invalid login payload" : body.error,
      });
      return true;
    }
    const login = body.value as LoginBody;
    const identifierRaw = login.identifier ?? login.username;
    const identifier = typeof identifierRaw === "string" ? identifierRaw.trim() : "";
    const password = typeof login.password === "string" ? login.password : "";
    const currentSessionValue = readPlatformClawSessionCookie(req);
    const result = await options.service.loginPassword({
      login: { identifier, password },
      currentSession: currentSessionValue ? { value: currentSessionValue } : undefined,
      context: {
        clientIp: options.clientIp,
        gatewayUrl: options.gatewayUrl,
        userAgent: req.headers["user-agent"],
      },
    });
    if (result.status === "rejected") {
      options.rateLimiter.recordFailure(options.clientIp, LOGIN_RATE_LIMIT_SCOPE);
      sendJson(res, 401, { authenticated: false, message: result.message });
      return true;
    }
    if (result.status !== "authenticated") {
      const status =
        result.status === "session-limit" ? 409 : result.status === "account-disabled" ? 403 : 503;
      sendJson(res, status, { authenticated: false, reason: result.status });
      return true;
    }
    appendSetCookie(res, serializeSessionCookie(result.token, options.requestIsSecure));
    sendJson(res, 200, {
      authenticated: true,
      user: {
        accountId: result.user.accountId,
        displayName: result.user.displayName,
        department: result.user.department,
        globalRole: result.user.globalRole,
      },
      agent: {
        agentId: result.binding.agentId,
        state: result.binding.state,
      },
      session: {
        idleExpiresAt: result.session.idleExpiresAt,
        absoluteExpiresAt: result.session.absoluteExpiresAt,
      },
    });
    return true;
  }

  if (pathname === PLATFORMCLAW_SESSION_PATH) {
    if (method !== "GET" && method !== "HEAD") {
      methodNotAllowed(res, "GET, HEAD");
      return true;
    }
    const token = readPlatformClawSessionCookie(req);
    if (!token) {
      sendJson(res, 200, method === "HEAD" ? undefined : { authenticated: false });
      return true;
    }
    const result = await options.service.authenticateToken(token);
    if (result.status !== "active") {
      clearSessionCookie(res, options.requestIsSecure);
      sendJson(res, 200, method === "HEAD" ? undefined : { authenticated: false });
      return true;
    }
    sendJson(
      res,
      200,
      method === "HEAD"
        ? undefined
        : {
            authenticated: true,
            user: {
              accountId: result.user.accountId,
              displayName: result.user.displayName,
              department: result.user.department,
              globalRole: result.user.globalRole,
            },
            session: {
              idleExpiresAt: result.session.idleExpiresAt,
              absoluteExpiresAt: result.session.absoluteExpiresAt,
            },
          },
    );
    return true;
  }

  if (pathname === PLATFORMCLAW_LOGOUT_PATH) {
    if (method !== "POST") {
      methodNotAllowed(res, "POST");
      return true;
    }
    if (!options.isMutationOriginAllowed(req)) {
      sendJson(res, 403, { ok: false, message: "origin not allowed" });
      return true;
    }
    const token = readPlatformClawSessionCookie(req);
    if (token) {
      await options.service.logout(token);
    }
    clearSessionCookie(res, options.requestIsSecure);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
