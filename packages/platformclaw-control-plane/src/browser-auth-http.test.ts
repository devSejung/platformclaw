import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  handlePlatformClawBrowserAuthRequest,
  PLATFORMCLAW_LOGIN_PATH,
  PLATFORMCLAW_SESSION_COOKIE,
} from "./browser-auth-http.js";
import { BrowserAuthService } from "./browser-auth-service.js";
import type { ControlPlaneIdFactory } from "./contracts.js";
import {
  EmployeeSsoService,
  PLATFORMCLAW_ADSSO_PATH,
  PLATFORMCLAW_SSO_CALLBACK_PATH,
} from "./employee-sso.js";
import { InMemoryControlPlaneStore } from "./memory-store.js";

function ids(): ControlPlaneIdFactory {
  let value = 0;
  return {
    nextUserId: () => `user-${++value}`,
    nextBindingId: () => `binding-${++value}`,
    nextSessionId: () => `session-${++value}`,
    nextManagedScopeId: () => `scope-${++value}`,
    nextAuditEventId: () => `audit-${++value}`,
  };
}

function responseHarness() {
  const headers = new Map<string, string | string[]>();
  let body = "";
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string | string[]) => headers.set(name, value),
    getHeader: (name: string) => headers.get(name),
    end: (value?: unknown) => {
      body = typeof value === "string" ? value : "";
    },
  } as unknown as ServerResponse;
  return { res, headers, body: () => body };
}

function createService() {
  return new BrowserAuthService({
    store: new InMemoryControlPlaneStore({
      idFactory: ids(),
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    }),
    authenticator: {
      async authenticatePassword() {
        return {
          status: "authenticated" as const,
          principal: {
            provider: "ldap" as const,
            subject: "seungon.jung",
            accountId: "seungon.jung",
            employeeId: "seungon.jung",
            displayName: "Seungon Jung",
            department: "Platform",
          },
          profile: {
            employeeId: "seungon.jung",
            accountId: "seungon.jung",
            subject: "seungon.jung",
            displayName: "Seungon Jung",
            department: "Platform",
            groups: [],
            attributes: {},
          },
        };
      },
    },
    provisioner: { provisionOrRefresh: vi.fn(async () => undefined) },
    now: () => 1_000,
    tokenFactory: () => "test-token-factory",
  });
}

function createRateLimiter() {
  return {
    check: () => ({ allowed: true, retryAfterMs: 0 }),
    recordFailure: vi.fn(),
  };
}

function signSsoHandoff(): string {
  const source = Buffer.from(
    JSON.stringify({
      contractVersion: 1,
      kind: "sso",
      issuer: "platformclaw-auth",
      audience: "platformclaw",
      authMethod: "saml",
      employeeId: "seungon.jung",
      name: "Seungon Jung",
      department: "Platform",
      agentId: "legacy-agent",
      sessionKey: "agent:legacy-agent:main",
      iat: 1,
      exp: 61,
    }),
    "utf8",
  );
  return `${source.toString("base64url")}.${createHmac("sha256", "s".repeat(32))
    .update(source)
    .digest("base64url")}`;
}

describe("PlatformClaw browser auth HTTP boundary", () => {
  it("redirects ADSSO through the 1.0 paths and returns to the requested 2.0 page", async () => {
    const service = createService();
    const ssoService = new EmployeeSsoService({
      authService: service,
      config: {
        loginUrl: "https://auth.example.test/adsso",
        handoffSecret: "s".repeat(32),
      },
      now: () => 1_000,
    });
    const start = responseHarness();
    await handlePlatformClawBrowserAuthRequest(
      {
        url: `${PLATFORMCLAW_ADSSO_PATH}?returnTo=%2Fplatformclaw%2Fapp%2Fsessions`,
        method: "GET",
        headers: {},
      } as IncomingMessage,
      start.res,
      {
        service,
        ssoService,
        requestIsSecure: true,
        isMutationOriginAllowed: () => true,
        rateLimiter: createRateLimiter(),
        readJsonBody: vi.fn(),
      },
    );
    expect(start.res.statusCode).toBe(302);
    expect(start.headers.get("Location")).toBe("https://auth.example.test/adsso/login");
    const returnCookie = String(start.headers.get("Set-Cookie"));
    expect(returnCookie).toContain("platformclaw_sso_return_to=");
    expect(returnCookie).toContain("HttpOnly");
    expect(returnCookie).toContain("Secure");

    const callback = responseHarness();
    await handlePlatformClawBrowserAuthRequest(
      {
        url: `${PLATFORMCLAW_SSO_CALLBACK_PATH}?token=${encodeURIComponent(signSsoHandoff())}`,
        method: "GET",
        headers: { cookie: returnCookie.split(";", 1)[0] },
      } as IncomingMessage,
      callback.res,
      {
        service,
        ssoService,
        requestIsSecure: true,
        isMutationOriginAllowed: () => true,
        rateLimiter: createRateLimiter(),
        readJsonBody: vi.fn(),
      },
    );
    expect(callback.res.statusCode).toBe(302);
    expect(callback.headers.get("Location")).toBe("/platformclaw/app/sessions");
    expect(callback.headers.get("Set-Cookie")).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${PLATFORMCLAW_SESSION_COOKIE}=test-token-factory`),
        expect.stringContaining("platformclaw_sso_return_to=; Max-Age=0"),
      ]),
    );
  });

  it("returns to login with a visible error when ADSSO is not configured", async () => {
    const harness = responseHarness();
    await handlePlatformClawBrowserAuthRequest(
      { url: PLATFORMCLAW_ADSSO_PATH, method: "GET", headers: {} } as IncomingMessage,
      harness.res,
      {
        service: createService(),
        requestIsSecure: false,
        isMutationOriginAllowed: () => true,
        rateLimiter: createRateLimiter(),
        readJsonBody: vi.fn(),
      },
    );
    expect(harness.res.statusCode).toBe(302);
    expect(harness.headers.get("Location")).toBe("/platformclaw/login?adssoError=unavailable");
  });

  it("sets an HttpOnly secure cookie and never returns the opaque token in JSON", async () => {
    const harness = responseHarness();
    const handled = await handlePlatformClawBrowserAuthRequest(
      {
        url: PLATFORMCLAW_LOGIN_PATH,
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "test-browser" },
      } as IncomingMessage,
      harness.res,
      {
        service: createService(),
        requestIsSecure: true,
        isMutationOriginAllowed: () => true,
        rateLimiter: createRateLimiter(),
        readJsonBody: async () => ({
          ok: true,
          value: { identifier: "seungon.jung", password: "test-password" },
        }),
      },
    );

    expect(handled).toBe(true);
    expect(harness.res.statusCode).toBe(200);
    expect(harness.headers.get("Set-Cookie")).toContain(
      `${PLATFORMCLAW_SESSION_COOKIE}=test-token-factory`,
    );
    expect(harness.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(harness.headers.get("Set-Cookie")).toContain("Secure");
    expect(harness.headers.get("Set-Cookie")).toContain("SameSite=Lax");
    expect(harness.body()).not.toContain("test-token-factory");
    expect(JSON.parse(harness.body())).toMatchObject({
      authenticated: true,
      user: { accountId: "seungon.jung" },
      agent: { agentId: "seungon_jung", state: "active" },
    });
  });

  it("rate limits before reading credentials or calling the auth service", async () => {
    const readJsonBody = vi.fn();
    const harness = responseHarness();
    await handlePlatformClawBrowserAuthRequest(
      {
        url: PLATFORMCLAW_LOGIN_PATH,
        method: "POST",
        headers: { "content-type": "application/json" },
      } as IncomingMessage,
      harness.res,
      {
        service: createService(),
        requestIsSecure: false,
        isMutationOriginAllowed: () => true,
        readJsonBody,
        clientIp: "192.0.2.10",
        rateLimiter: {
          check: () => ({ allowed: false, retryAfterMs: 15_000 }),
          recordFailure: vi.fn(),
        },
      },
    );
    expect(harness.res.statusCode).toBe(429);
    expect(harness.headers.get("Retry-After")).toBe("15");
    expect(readJsonBody).not.toHaveBeenCalled();
  });

  it("rejects a disallowed login origin before reading the password", async () => {
    const readJsonBody = vi.fn();
    const harness = responseHarness();
    await handlePlatformClawBrowserAuthRequest(
      {
        url: PLATFORMCLAW_LOGIN_PATH,
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://cross-site.test" },
      } as IncomingMessage,
      harness.res,
      {
        service: createService(),
        requestIsSecure: true,
        isMutationOriginAllowed: () => false,
        rateLimiter: createRateLimiter(),
        readJsonBody,
      },
    );
    expect(harness.res.statusCode).toBe(403);
    expect(readJsonBody).not.toHaveBeenCalled();
  });
});
