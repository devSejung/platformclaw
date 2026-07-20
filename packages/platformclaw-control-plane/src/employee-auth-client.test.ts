import { describe, expect, it, vi } from "vitest";
import {
  EMPLOYEE_AUTH_BEARER_TOKEN_ENV,
  EMPLOYEE_AUTH_LOGIN_URL_ENV,
  HttpEmployeeAuthenticator,
  loadEmployeeAuthClientConfig,
} from "./employee-auth-client.js";

describe("employee auth client config", () => {
  it("loads the canonical PlatformClaw environment variables", () => {
    expect(
      loadEmployeeAuthClientConfig({
        [EMPLOYEE_AUTH_LOGIN_URL_ENV]: " http://127.0.0.1:18080/login ",
        [EMPLOYEE_AUTH_BEARER_TOKEN_ENV]: " test-bearer-token ",
      }),
    ).toEqual({
      loginUrl: "http://127.0.0.1:18080/login",
      bearerToken: "test-bearer-token",
      provider: "ldap",
    });
  });

  it("rejects missing and non-http login URLs", () => {
    expect(() => loadEmployeeAuthClientConfig({})).toThrow(EMPLOYEE_AUTH_LOGIN_URL_ENV);
    expect(() =>
      loadEmployeeAuthClientConfig({ [EMPLOYEE_AUTH_LOGIN_URL_ENV]: "file:///auth" }),
    ).toThrow("must use https");
    expect(() =>
      loadEmployeeAuthClientConfig({
        [EMPLOYEE_AUTH_LOGIN_URL_ENV]: "http://employee-auth.example.test/login",
      }),
    ).toThrow("loopback mock");
  });
});

describe("HttpEmployeeAuthenticator", () => {
  it("normalizes the full legacy profile while control-plane owns agent routing", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            authenticated: true,
            employeeId: "Seungon.Jung",
            name: "Seungon Jung",
            email: "seungon.jung@example.test",
            department: "Platform",
            part: "Agent Part",
            confluenceSpace: "PLATFORM",
            notes: "Jira and Confluence user",
            groups: ["developers", "platform", "developers"],
            attributes: { title: "Engineer", costCenters: ["A", "B"] },
            agentId: "external-agent-must-be-ignored",
            sessionKey: "external-session-must-be-ignored",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const authenticator = new HttpEmployeeAuthenticator(
      {
        loginUrl: "https://auth.test/login",
        bearerToken: "test-bearer-token",
      },
      fetchImpl,
    );

    const result = await authenticator.authenticatePassword({
      login: { identifier: " seungon.jung ", password: "test-password" },
      context: { clientIp: "192.0.2.10", userAgent: "browser" },
    });

    expect(result).toEqual({
      status: "authenticated",
      principal: {
        provider: "ldap",
        subject: "seungon.jung",
        accountId: "seungon.jung",
        employeeId: "Seungon.Jung",
        displayName: "Seungon Jung",
        email: "seungon.jung@example.test",
        department: "Platform",
        groups: ["developers", "platform"],
      },
      profile: {
        employeeId: "Seungon.Jung",
        accountId: "seungon.jung",
        subject: "seungon.jung",
        displayName: "Seungon Jung",
        email: "seungon.jung@example.test",
        department: "Platform",
        part: "Agent Part",
        confluenceSpace: "PLATFORM",
        notes: "Jira and Confluence user",
        groups: ["developers", "platform"],
        attributes: { title: "Engineer", costCenters: ["A", "B"] },
      },
    });
    const [, request] = fetchImpl.mock.calls[0] ?? [];
    expect(request?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer test-bearer-token",
    });
    expect(request?.redirect).toBe("error");
    expect(JSON.parse(String(request?.body))).toEqual({
      identifier: "seungon.jung",
      password: "test-password",
      clientIp: "192.0.2.10",
      gatewayUrl: null,
      userAgent: "browser",
    });
  });

  it("separates credential rejection from an invalid upstream response", async () => {
    const rejected = new HttpEmployeeAuthenticator(
      { loginUrl: "https://auth.test/login" },
      vi.fn(
        async () =>
          new Response(JSON.stringify({ authenticated: false, message: "invalid credentials" }), {
            status: 401,
          }),
      ),
    );
    await expect(
      rejected.authenticatePassword({
        login: { identifier: "eon", password: "wrong" },
        context: {},
      }),
    ).resolves.toEqual({ status: "rejected", message: "invalid credentials" });

    const invalid = new HttpEmployeeAuthenticator(
      { loginUrl: "https://auth.test/login" },
      vi.fn(async () => new Response(JSON.stringify({ authenticated: true }), { status: 200 })),
    );
    await expect(
      invalid.authenticatePassword({
        login: { identifier: "eon", password: "test-password" },
        context: {},
      }),
    ).resolves.toEqual({
      status: "unavailable",
      message: "employee authentication response was invalid",
    });

    const failedService = new HttpEmployeeAuthenticator(
      { loginUrl: "https://auth.test/login" },
      vi.fn(
        async () =>
          new Response(JSON.stringify({ authenticated: false, message: "backend failed" }), {
            status: 500,
          }),
      ),
    );
    await expect(
      failedService.authenticatePassword({
        login: { identifier: "eon", password: "test-password" },
        context: {},
      }),
    ).resolves.toEqual({
      status: "unavailable",
      message: "employee authentication failed (500)",
    });
  });
});
