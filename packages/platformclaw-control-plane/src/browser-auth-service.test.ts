import { describe, expect, it, vi } from "vitest";
import { BrowserAuthService, hashBrowserSessionToken } from "./browser-auth-service.js";
import type { ControlPlaneIdFactory } from "./contracts.js";
import type { EmployeeAuthenticationResult } from "./employee-auth-client.js";
import { InMemoryControlPlaneStore } from "./memory-store.js";

function createIdFactory(): ControlPlaneIdFactory {
  let user = 0;
  let binding = 0;
  let session = 0;
  let scope = 0;
  let audit = 0;
  return {
    nextUserId: () => `user-${++user}`,
    nextBindingId: () => `binding-${++binding}`,
    nextSessionId: () => `session-${++session}`,
    nextManagedScopeId: () => `scope-${++scope}`,
    nextAuditEventId: () => `audit-${++audit}`,
  };
}

function authResult(): Extract<EmployeeAuthenticationResult, { status: "authenticated" }> {
  return {
    status: "authenticated",
    principal: {
      provider: "ldap",
      subject: "seungon.jung",
      accountId: "seungon.jung",
      employeeId: "employee-123",
      displayName: "Seungon Jung",
      department: "Platform",
      groups: ["platform"],
    },
    profile: {
      employeeId: "employee-123",
      accountId: "seungon.jung",
      subject: "seungon.jung",
      displayName: "Seungon Jung",
      department: "Platform",
      part: "Agent Part",
      confluenceSpace: "PLATFORM",
      notes: "profile notes",
      groups: ["platform"],
      attributes: {},
    },
  };
}

function createHarness() {
  let now = 1_000;
  const store = new InMemoryControlPlaneStore({
    idFactory: createIdFactory(),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  const authenticator = {
    async authenticatePassword(): Promise<EmployeeAuthenticationResult> {
      return authResult();
    },
  };
  const provisioner = { provisionOrRefresh: vi.fn(async () => undefined) };
  const syncOrganization = vi.fn(
    async (_params: {
      userId: string;
      org: unknown;
      isTestAccount: boolean;
      syncedAt: number;
    }): Promise<void> => undefined,
  );
  const service = new BrowserAuthService({
    store,
    authenticator,
    provisioner,
    now: () => now,
    tokenFactory: () => "test-token-factory",
    syncOrganization,
  });
  return {
    service,
    store,
    authenticator,
    provisioner,
    syncOrganization,
    setNow: (value: number) => (now = value),
  };
}

describe("BrowserAuthService", () => {
  it("provisions the personal agent, derives its id, and stores only the token hash", async () => {
    const { service, provisioner } = createHarness();
    const result = await service.loginPassword({
      login: { identifier: "seungon.jung", password: "test-password" },
    });

    expect(result.status).toBe("authenticated");
    if (result.status !== "authenticated") {
      return;
    }
    expect(result.binding).toMatchObject({ agentId: "seungon_jung", state: "active" });
    expect(result.token).toBe("test-token-factory");
    expect(result.session.tokenHash).toBe(hashBrowserSessionToken("test-token-factory"));
    expect(result.session.tokenHash).not.toContain("test-token-factory");
    expect(provisioner.provisionOrRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        createdBinding: true,
        profile: expect.objectContaining({
          part: "Agent Part",
          confluenceSpace: "PLATFORM",
          notes: "profile notes",
        }),
      }),
    );
  });

  it("resolves and revokes an opaque browser session", async () => {
    const { service, setNow } = createHarness();
    await service.loginPassword({
      login: { identifier: "seungon.jung", password: "test-password" },
    });
    setNow(2_000);
    await expect(service.authenticateToken("test-token-factory")).resolves.toMatchObject({
      status: "active",
      user: { accountId: "seungon.jung" },
    });
    await expect(service.logout("test-token-factory")).resolves.toBe(true);
    await expect(service.authenticateToken("test-token-factory")).resolves.toEqual({
      status: "unauthenticated",
      reason: "revoked",
    });
  });

  it("reuses the current session when the same user signs in again", async () => {
    const { service, syncOrganization, setNow } = createHarness();
    const first = await service.loginPassword({
      login: { identifier: "seungon.jung", password: "test-password" },
    });
    expect(first.status).toBe("authenticated");
    if (first.status !== "authenticated") {
      throw new Error("expected authenticated test session");
    }
    setNow(2_000);
    const second = await service.loginPassword({
      login: { identifier: "seungon.jung", password: "test-password" },
      currentSession: { value: first.token },
    });
    expect(second).toMatchObject({
      status: "authenticated",
      session: { id: "session-1" },
    });
    if (second.status === "authenticated") {
      expect(second.token).toBe(first.token);
    }
    expect(syncOrganization).toHaveBeenCalledTimes(2);
    expect(syncOrganization).toHaveBeenLastCalledWith({
      userId: first.user.id,
      org: undefined,
      isTestAccount: false,
      syncedAt: 2_000,
    });
  });

  it("synchronizes only after a successful session using the canonical user id", async () => {
    const { service, store, authenticator, syncOrganization } = createHarness();
    const org = { version: 1, source: "aicm", part: { id: "42", name: "Part" } };
    vi.spyOn(authenticator, "authenticatePassword").mockResolvedValue({ ...authResult(), org });
    syncOrganization.mockImplementation(async ({ userId }) => {
      await expect(
        store.resolveBrowserSession({
          tokenHash: hashBrowserSessionToken("test-token-factory"),
          resolvedAt: 1_000,
        }),
      ).resolves.toMatchObject({ status: "active", user: { id: userId } });
    });
    await expect(
      service.loginPassword({
        login: { identifier: "seungon.jung", password: "test-password" },
      }),
    ).resolves.toMatchObject({ status: "authenticated" });
    expect(syncOrganization).toHaveBeenCalledExactlyOnceWith({
      userId: "user-1",
      org,
      isTestAccount: false,
      syncedAt: 1_000,
    });
  });

  it("keeps login successful and redacts organization sync failures", async () => {
    const { service, syncOrganization } = createHarness();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    syncOrganization.mockRejectedValueOnce(new Error("private directory payload"));
    try {
      await expect(
        service.loginPassword({
          login: { identifier: "seungon.jung", password: "test-password" },
        }),
      ).resolves.toMatchObject({ status: "authenticated" });
      await expect(service.authenticateToken("test-token-factory")).resolves.toMatchObject({
        status: "active",
      });
      expect(warning).toHaveBeenCalledExactlyOnceWith("directory_organization_sync_failed", {
        userId: "user-1",
      });
      await expect(
        service.loginPassword({
          login: { identifier: "seungon.jung", password: "test-password" },
          currentSession: { value: "test-token-factory" },
        }),
      ).resolves.toMatchObject({ status: "authenticated" });
      expect(syncOrganization).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  });

  it.each(["rejected", "unavailable", "disabled", "session-limit"])(
    "does not synchronize when login ends with %s",
    async (failure) => {
      const { service, store, authenticator, syncOrganization } = createHarness();
      if (failure === "rejected" || failure === "unavailable") {
        vi.spyOn(authenticator, "authenticatePassword").mockResolvedValue({
          status: failure,
          message: "auth failed",
        });
      } else if (failure === "disabled") {
        const user = await store.upsertPrincipal(authResult().principal, 1_000);
        const binding = await store.reservePersonalAgent(user.user.id, 1_000);
        await store.transitionAgent({
          bindingId: binding.binding.id,
          state: "disabled",
          changedAt: 1_000,
        });
      } else {
        vi.spyOn(store, "createBrowserSession").mockResolvedValue({
          status: "limit-reached",
          activeSessionCount: 5,
        });
      }
      const result = await service.loginPassword({
        login: { identifier: "seungon.jung", password: "test-password" },
      });
      expect(result.status).not.toBe("authenticated");
      expect(syncOrganization).not.toHaveBeenCalled();
    },
  );

  it("single-flights concurrent provisioning for one personal binding", async () => {
    const store = new InMemoryControlPlaneStore({
      idFactory: createIdFactory(),
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    });
    let releaseProvisioning: (() => void) | undefined;
    const provisioningGate = new Promise<void>((resolve) => {
      releaseProvisioning = resolve;
    });
    const provisioner = { provisionOrRefresh: vi.fn(() => provisioningGate) };
    const service = new BrowserAuthService({
      store,
      authenticator: {
        async authenticatePassword() {
          return authResult();
        },
      },
      provisioner,
      now: () => 1_000,
    });

    const first = service.loginPassword({
      login: { identifier: "seungon.jung", password: "test-password" },
    });
    const second = service.loginPassword({
      login: { identifier: "seungon.jung", password: "test-password" },
    });
    await vi.waitFor(() => expect(provisioner.provisionOrRefresh).toHaveBeenCalledTimes(1));
    releaseProvisioning?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "authenticated" }),
      expect.objectContaining({ status: "authenticated" }),
    ]);
    expect(provisioner.provisionOrRefresh).toHaveBeenCalledTimes(2);
  });

  it("marks a new binding failed when workspace provisioning fails", async () => {
    const { service, store, provisioner, syncOrganization } = createHarness();
    provisioner.provisionOrRefresh.mockRejectedValueOnce(new Error("workspace unavailable"));

    await expect(
      service.loginPassword({
        login: { identifier: "seungon.jung", password: "test-password" },
      }),
    ).resolves.toEqual({ status: "provisioning-failed", message: "workspace unavailable" });

    const user = await store.getUserByEmployeeId("employee-123");
    expect(user).not.toBeNull();
    const binding = await store.reservePersonalAgent(user!.id, 2_000);
    expect(binding.binding).toMatchObject({ state: "failed", failureCode: "provisioner_error" });
    expect(syncOrganization).not.toHaveBeenCalled();
  });

  it("marks a stale active binding failed when Gateway revalidation fails", async () => {
    const { service, store, provisioner } = createHarness();
    await expect(
      service.loginPassword({
        login: { identifier: "seungon.jung", password: "test-password" },
      }),
    ).resolves.toMatchObject({ status: "authenticated" });
    provisioner.provisionOrRefresh.mockRejectedValueOnce(new Error("Gateway agent missing"));

    await expect(
      service.loginPassword({
        login: { identifier: "seungon.jung", password: "test-password" },
      }),
    ).resolves.toEqual({ status: "provisioning-failed", message: "Gateway agent missing" });

    const user = await store.getUserByEmployeeId("employee-123");
    const binding = await store.getPersonalAgentBinding(user!.id);
    expect(binding).toMatchObject({ state: "failed", failureCode: "provisioner_error" });
  });

  it("creates the browser session at the post-provisioning time", async () => {
    const store = new InMemoryControlPlaneStore({
      idFactory: createIdFactory(),
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    });
    const times = [1_000, 5_000];
    const service = new BrowserAuthService({
      store,
      authenticator: {
        async authenticatePassword() {
          return authResult();
        },
      },
      provisioner: { async provisionOrRefresh() {} },
      now: () => times.shift() ?? 5_000,
      tokenFactory: () => "test-token-factory",
    });

    const result = await service.loginPassword({
      login: { identifier: "seungon.jung", password: "test-password" },
    });
    expect(result).toMatchObject({
      status: "authenticated",
      session: { createdAt: 5_000 },
    });
  });
});
