import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { BrowserAuthService } from "./browser-auth-service.js";
import {
  handlePlatformClawVmAdministrationRequest,
  PLATFORMCLAW_VM_ADMIN_PATH,
  VmAdministrationService,
} from "./browser-vm-admin-http.js";
import type { ControlPlaneAuditReader } from "./contracts.js";
import type {
  ControlPlaneEmployeeExecutionStore,
  ControlPlaneExecutionManagementStore,
  ControlPlaneVmLifecycleStore,
} from "./execution-contracts.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";

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

function createService(
  role: "member" | "admin",
  probeEndpoint?: ConstructorParameters<typeof VmAdministrationService>[0]["probeEndpoint"],
) {
  const snapshot = { endpoints: [], hosts: [], agents: [], allocations: [] };
  const getVmAdministrationSnapshot = vi.fn(async () => snapshot);
  const createSafeConnectEndpoint = vi.fn(async () => ({ id: "endpoint-one" }));
  const enableSafeConnectEndpoint = vi.fn(async () => ({ id: "endpoint-one", status: "active" }));
  const updateVmHostExecutionEnvironment = vi.fn(async () => ({ id: "vm-one" }));
  const store = {
    getVmAdministrationSnapshot,
    listAuditEvents: vi.fn(async () => []),
    createSafeConnectEndpoint,
    enableSafeConnectEndpoint,
    updateVmHostExecutionEnvironment,
    getPersonalExecutionSettings: vi.fn(async () => null),
  } as unknown as ControlPlaneExecutionManagementStore &
    ControlPlaneEmployeeExecutionStore &
    ControlPlaneVmLifecycleStore &
    ControlPlaneAuditReader;
  const authService = {
    authenticateToken: vi.fn(async () => ({
      status: "active",
      user: { id: "user-one", globalRole: role },
    })),
  } as unknown as BrowserAuthService;
  return {
    service: new VmAdministrationService({
      authService,
      store,
      adminRpc: { call: vi.fn() } as unknown as GatewayAdminRpc,
      now: () => 123,
      ...(probeEndpoint ? { probeEndpoint } : {}),
    }),
    getVmAdministrationSnapshot,
    createSafeConnectEndpoint,
    enableSafeConnectEndpoint,
    updateVmHostExecutionEnvironment,
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

  it("probes a SafeConnect endpoint without persisting it", async () => {
    const probeEndpoint = vi.fn(async () => ({
      host: "safeconnect.example.test",
      port: 44_422,
      resolvedAddresses: ["192.0.2.20"],
      sshBanner: "SSH-2.0-SafeConnect",
      algorithm: "ssh-ed25519" as const,
      publicKey: "key",
      fingerprint: "SHA256:fingerprint",
    }));
    const { service, createSafeConnectEndpoint } = createService("admin", probeEndpoint);

    const result = await service.mutate("user-one", "probe-endpoint", {
      host: "safeconnect.example.test",
      port: 44_422,
    });

    expect(result).toMatchObject({ probe: { fingerprint: "SHA256:fingerprint" } });
    expect(createSafeConnectEndpoint).not.toHaveBeenCalled();
  });

  it("re-enables a disabled endpoint through the supported lifecycle API", async () => {
    const { service, enableSafeConnectEndpoint } = createService("admin");

    await service.mutate("user-one", "enable-endpoint", { endpointId: "endpoint-one" });

    expect(enableSafeConnectEndpoint).toHaveBeenCalledWith({
      actorUserId: "user-one",
      endpointId: "endpoint-one",
      enabledAt: 123,
    });
  });

  it("validates and stores a VM-specific build environment", async () => {
    const { service, updateVmHostExecutionEnvironment } = createService("admin");

    await service.mutate("user-one", "update-host-execution-environment", {
      vmHostId: "vm-one",
      executionEnvironment: {
        pathPrepend: ["/opt/clang/bin/"],
        variables: {
          TOOLCHAIN_PREFIX: "/opt/gcc/bin/aarch64-elf-",
          CLANG11_PATH: "/opt/clang/bin/",
        },
      },
    });

    expect(updateVmHostExecutionEnvironment).toHaveBeenCalledWith({
      actorUserId: "user-one",
      vmHostId: "vm-one",
      executionEnvironment: {
        pathPrepend: ["/opt/clang/bin"],
        variables: {
          CLANG11_PATH: "/opt/clang/bin/",
          TOOLCHAIN_PREFIX: "/opt/gcc/bin/aarch64-elf-",
        },
      },
      updatedAt: 123,
    });
  });

  it("rejects dangerous VM environment variables before storage", async () => {
    const { service, updateVmHostExecutionEnvironment } = createService("admin");

    await expect(
      service.mutate("user-one", "update-host-execution-environment", {
        vmHostId: "vm-one",
        executionEnvironment: { pathPrepend: [], variables: { LD_PRELOAD: "/tmp/bad.so" } },
      }),
    ).rejects.toThrow("not allowed");
    expect(updateVmHostExecutionEnvironment).not.toHaveBeenCalled();
  });
});
