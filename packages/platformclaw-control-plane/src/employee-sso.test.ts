import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BrowserAuthService } from "./browser-auth-service.js";
import type { ControlPlaneIdFactory } from "./contracts.js";
import { EmployeeSsoService, normalizeEmployeeSsoLoginUrl } from "./employee-sso.js";
import { InMemoryControlPlaneStore } from "./memory-store.js";

const nowMs = 1_700_000_000_000;
const nowSeconds = Math.floor(nowMs / 1000);
const handoffSecret = "s".repeat(32);

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

function sign(payload: Record<string, unknown>, secret = handoffSecret): string {
  const source = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = createHmac("sha256", secret).update(source).digest("base64url");
  return `${source.toString("base64url")}.${signature}`;
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    kind: "sso",
    issuer: "platformclaw-auth",
    audience: "platformclaw",
    authMethod: "saml",
    employeeId: "Person.One",
    name: "Person One",
    email: "person.one@example.test",
    department: "Platform",
    part: "Agent Part",
    confluenceSpace: "PLATFORM",
    agentId: "legacy-agent-id",
    sessionKey: "agent:legacy-agent-id:main",
    iat: nowSeconds,
    exp: nowSeconds + 60,
    ...overrides,
  };
}

function createService() {
  const store = new InMemoryControlPlaneStore({
    idFactory: ids(),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  const authService = new BrowserAuthService({
    store,
    authenticator: {
      async authenticatePassword() {
        return { status: "rejected" as const, message: "password auth not expected" };
      },
    },
    provisioner: { provisionOrRefresh: vi.fn(async () => undefined) },
    now: () => nowMs,
    tokenFactory: () => "sso-browser-session",
  });
  return {
    store,
    service: new EmployeeSsoService({
      authService,
      config: { loginUrl: "https://auth.example.test/adsso", handoffSecret },
      now: () => nowMs,
    }),
  };
}

describe("EmployeeSsoService", () => {
  it("accepts the PlatformClaw 1.0 handoff and creates a 2.0 SAML session", async () => {
    const { service, store } = createService();
    const token = sign(payload());

    await expect(service.complete(token)).resolves.toMatchObject({
      status: "authenticated",
      token: "sso-browser-session",
      user: { accountId: "person.one", employeeId: "person.one" },
      binding: { agentId: "person_one", state: "active" },
    });
    await expect(store.getUserByEmployeeId("person.one")).resolves.toMatchObject({
      accountId: "person.one",
    });
    await expect(service.complete(token)).resolves.toEqual({ status: "invalid-handoff" });
  });

  it.each([
    ["wrong audience", { audience: "other" }],
    ["expired token", { iat: nowSeconds - 61, exp: nowSeconds }],
    ["long lifetime", { exp: nowSeconds + 61 }],
    ["expiry before issue", { iat: nowSeconds + 20, exp: nowSeconds + 10 }],
    ["missing legacy agent", { agentId: undefined }],
  ])("rejects %s", async (_name, overrides) => {
    const { service } = createService();
    await expect(service.complete(sign(payload(overrides)))).resolves.toEqual({
      status: "invalid-handoff",
    });
  });

  it("rejects a token signed by another secret", async () => {
    const { service } = createService();
    await expect(service.complete(sign(payload(), "x".repeat(32)))).resolves.toEqual({
      status: "invalid-handoff",
    });
  });

  it("normalizes the external login endpoint and rejects insecure remote URLs", () => {
    expect(normalizeEmployeeSsoLoginUrl("https://auth.example.test/adsso")).toBe(
      "https://auth.example.test/adsso/login",
    );
    expect(normalizeEmployeeSsoLoginUrl("http://127.0.0.1:18080/adsso/login")).toBe(
      "http://127.0.0.1:18080/adsso/login",
    );
    expect(() => normalizeEmployeeSsoLoginUrl("http://auth.example.test/adsso")).toThrow(
      "must use https",
    );
    expect(() => normalizeEmployeeSsoLoginUrl("http://127.example.test/adsso")).toThrow(
      "must use https",
    );
  });
});
