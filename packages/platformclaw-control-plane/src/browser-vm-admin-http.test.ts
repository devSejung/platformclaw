import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { BrowserAuthService } from "./browser-auth-service.js";
import {
  handlePlatformClawVmAdministrationRequest,
  PLATFORMCLAW_VM_ADMIN_PATH,
  VmAdministrationService,
} from "./browser-vm-admin-http.js";
import type { ControlPlaneAuditReader } from "./contracts.js";
import type { ControlPlaneExecutionManagementStore } from "./execution-contracts.js";

function responseHarness(): { response: ServerResponse; body(): unknown } {
  let responseBody = "";
  return {
    response: {
      statusCode: 200,
      setHeader: vi.fn(),
      end: (body?: unknown) => {
        responseBody = typeof body === "string" ? body : "";
      },
    } as unknown as ServerResponse,
    body: () => JSON.parse(responseBody) as unknown,
  };
}

function createService(role: "member" | "admin") {
  const snapshot = { endpoints: [], hosts: [], agents: [], allocations: [] };
  const getVmAdministrationSnapshot = vi.fn(async () => snapshot);
  const createSafeConnectEndpoint = vi.fn(async () => ({ id: "endpoint-one" }));
  const store = {
    getVmAdministrationSnapshot,
    listAuditEvents: vi.fn(async () => []),
    createSafeConnectEndpoint,
  } as unknown as ControlPlaneExecutionManagementStore & ControlPlaneAuditReader;
  const authService = {
    authenticateToken: vi.fn(async () => ({
      status: "active",
      user: { id: "user-one", globalRole: role },
    })),
  } as unknown as BrowserAuthService;
  return {
    service: new VmAdministrationService({ authService, store, now: () => 123 }),
    getVmAdministrationSnapshot,
    createSafeConnectEndpoint,
  };
}

describe("VM administration HTTP", () => {
  it("rejects non-administrators before reading administration state", async () => {
    const { service, getVmAdministrationSnapshot } = createService("member");
    const harness = responseHarness();

    await handlePlatformClawVmAdministrationRequest(
      {
        url: PLATFORMCLAW_VM_ADMIN_PATH,
        method: "GET",
        headers: { cookie: "platformclaw_session=test-token" },
      } as IncomingMessage,
      harness.response,
      { service, readJsonBody: vi.fn(), isMutationOriginAllowed: () => true },
    );

    expect(harness.response.statusCode).toBe(403);
    expect(harness.body()).toEqual({ error: "administrator access required" });
    expect(getVmAdministrationSnapshot).not.toHaveBeenCalled();
  });

  it("creates an endpoint and returns the refreshed snapshot", async () => {
    const { service, getVmAdministrationSnapshot, createSafeConnectEndpoint } =
      createService("admin");
    const harness = responseHarness();

    await handlePlatformClawVmAdministrationRequest(
      {
        url: PLATFORMCLAW_VM_ADMIN_PATH,
        method: "POST",
        headers: { cookie: "platformclaw_session=test-token" },
      } as IncomingMessage,
      harness.response,
      {
        service,
        isMutationOriginAllowed: () => true,
        readJsonBody: async () => ({
          ok: true,
          value: {
            action: "endpoints",
            label: "Corporate SafeConnect",
            host: "safeconnect.example.test",
            port: 44_422,
            adDomain: "example.test",
          },
        }),
      },
    );

    expect(harness.response.statusCode).toBe(200);
    expect(createSafeConnectEndpoint).toHaveBeenCalledWith({
      actorUserId: "user-one",
      label: "Corporate SafeConnect",
      host: "safeconnect.example.test",
      port: 44_422,
      adDomain: "example.test",
      createdAt: 123,
    });
    expect(getVmAdministrationSnapshot).toHaveBeenCalledWith("user-one");
  });

  it("requires a same-origin mutation", async () => {
    const { service, createSafeConnectEndpoint } = createService("admin");
    const harness = responseHarness();

    await handlePlatformClawVmAdministrationRequest(
      {
        url: PLATFORMCLAW_VM_ADMIN_PATH,
        method: "POST",
        headers: { cookie: "platformclaw_session=test-token" },
      } as IncomingMessage,
      harness.response,
      { service, readJsonBody: vi.fn(), isMutationOriginAllowed: () => false },
    );

    expect(harness.response.statusCode).toBe(403);
    expect(createSafeConnectEndpoint).not.toHaveBeenCalled();
  });
});
