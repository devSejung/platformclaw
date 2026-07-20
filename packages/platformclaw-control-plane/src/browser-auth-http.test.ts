import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  handlePlatformClawBrowserAuthRequest,
  PLATFORMCLAW_LOGIN_PATH,
  PLATFORMCLAW_SESSION_COOKIE,
} from "./browser-auth-http.js";
import { BrowserAuthService } from "./browser-auth-service.js";
import type { ControlPlaneIdFactory } from "./contracts.js";
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
      body = String(value ?? "");
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

describe("PlatformClaw browser auth HTTP boundary", () => {
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
