import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmployeeBrowserAuthRuntime } from "./browser-auth-runtime.js";
import { EMPLOYEE_AUTH_LOGIN_URL_ENV } from "./employee-auth-client.js";

describe("createEmployeeBrowserAuthRuntime", () => {
  const runtimes: Array<{ close(): void }> = [];

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) {
      runtime.close();
    }
  });

  it("wires employee authentication, persistent sessions, and provisioning", async () => {
    const sessionValue = "test-session-value";
    const provisioner = { provisionOrRefresh: vi.fn(async () => undefined) };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            authenticated: true,
            employeeId: "account.name",
            accountId: "account.name",
            name: "Account Name",
            department: "Platform",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const runtime = createEmployeeBrowserAuthRuntime({
      databasePath: ":memory:",
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      provisioner,
      initialAdminAccountIds: ["account.name"],
      employeeAuthConfig: { loginUrl: "http://127.0.0.1:18080/login" },
      fetchImpl,
      now: () => 1_000,
      tokenFactory: () => sessionValue,
    });
    runtimes.push(runtime);

    const login = await runtime.service.loginPassword({
      login: { identifier: "account.name", password: "test-password" },
    });

    expect(login).toMatchObject({
      status: "authenticated",
      user: { accountId: "account.name", globalRole: "admin" },
      binding: { agentId: "account_name", state: "active" },
    });
    expect(provisioner.provisionOrRefresh).toHaveBeenCalledOnce();
    await expect(runtime.service.authenticateToken(sessionValue, false)).resolves.toMatchObject({
      status: "active",
      user: { accountId: "account.name" },
    });
    await expect(runtime.service.logout(sessionValue)).resolves.toBe(true);
    await expect(runtime.service.authenticateToken(sessionValue, false)).resolves.toEqual({
      status: "unauthenticated",
      reason: "revoked",
    });
  });

  it("loads the employee login URL from deployment environment", async () => {
    const env: NodeJS.ProcessEnv = {};
    env[EMPLOYEE_AUTH_LOGIN_URL_ENV] = "http://127.0.0.1:18080/login";
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ authenticated: false, message: "no" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const runtime = createEmployeeBrowserAuthRuntime({
      databasePath: ":memory:",
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      provisioner: { async provisionOrRefresh() {} },
      initialAdminAccountIds: ["admin.account"],
      env,
      fetchImpl,
    });
    runtimes.push(runtime);

    await runtime.service.loginPassword({
      login: { identifier: "account.name", password: "test-password" },
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:18080/login");
  });
});
