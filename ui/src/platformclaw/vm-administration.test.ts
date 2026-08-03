import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPlatformClawVmAdministration } from "./vm-administration.ts";

function parseRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new TypeError("expected a JSON request body");
  }
  return JSON.parse(init.body);
}

const SNAPSHOT = {
  endpoints: [],
  hosts: [],
  agents: [
    {
      accountId: "person.one",
      agentId: "person_one",
      displayName: "Person One",
      department: "Platform",
    },
  ],
  allocations: [],
  auditEvents: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("PlatformClaw VM administration", () => {
  afterEach(() => document.querySelector("platformclaw-vm-administration")?.remove());

  it("loads administration state only after the administrator opens it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(SNAPSHOT));
    mountPlatformClawVmAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-vm-administration")!;

    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector("[data-open]")).not.toBeNull());
    element.shadowRoot?.querySelector<HTMLElement>("[data-open]")?.click();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.textContent).toContain("Employee assignments"),
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "/platformclaw/api/admin/vm",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(element.shadowRoot?.textContent).toContain("SafeConnect endpoints");
    expect(element.shadowRoot?.textContent).toContain("Employee assignments");
  });

  it("checks connectivity before saving and approving a new endpoint", async () => {
    const endpointSnapshot = {
      ...SNAPSHOT,
      endpoints: [
        {
          id: "endpoint-one",
          label: "Corporate access",
          host: "safeconnect.example.test",
          port: 44_422,
          adDomain: "example.test",
          status: "pending" as const,
        },
      ],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SNAPSHOT))
      .mockResolvedValueOnce(
        jsonResponse({
          ...SNAPSHOT,
          probe: {
            host: "safeconnect.example.test",
            port: 44_422,
            resolvedAddresses: ["192.0.2.20"],
            sshBanner: "SSH-2.0-SafeConnect",
            algorithm: "ssh-ed25519",
            publicKey: "public-key",
            fingerprint: "SHA256:fingerprint",
          },
        }),
      )
      .mockRejectedValueOnce(new TypeError("connection interrupted after create"))
      .mockResolvedValueOnce(jsonResponse(endpointSnapshot))
      .mockRejectedValueOnce(new TypeError("connection interrupted after approval"))
      .mockResolvedValueOnce(jsonResponse({ ...endpointSnapshot, endpoints: [] }));
    mountPlatformClawVmAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-vm-administration")!;
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector("[data-open]")).not.toBeNull());
    element.shadowRoot?.querySelector<HTMLElement>("[data-open]")?.click();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const form = element.shadowRoot?.querySelector<HTMLFormElement>("form[data-endpoint-probe]");
    if (!form) {
      throw new Error("endpoint form is missing");
    }
    (form.elements.namedItem("label") as HTMLInputElement).value = "Corporate access";
    (form.elements.namedItem("host") as HTMLInputElement).value = "safeconnect.example.test";
    (form.elements.namedItem("adDomain") as HTMLInputElement).value = "example.test";
    form.requestSubmit();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    const init = fetchImpl.mock.calls[1]?.[1];
    expect(init?.method).toBe("POST");
    if (typeof init?.body !== "string") {
      throw new Error("endpoint request body is missing");
    }
    expect(JSON.parse(init.body)).toEqual({
      action: "probe-endpoint",
      host: "safeconnect.example.test",
      port: 44_422,
    });
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector("[data-approve-probe]")).not.toBeNull(),
    );
    element.shadowRoot?.querySelector<HTMLElement>("[data-approve-probe]")?.click();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5));
    const createInit = fetchImpl.mock.calls[2]?.[1];
    const recoveryInit = fetchImpl.mock.calls[3]?.[1];
    const approveInit = fetchImpl.mock.calls[4]?.[1];
    expect(parseRequestBody(createInit)).toEqual({
      action: "endpoints",
      label: "Corporate access",
      host: "safeconnect.example.test",
      port: 44_422,
      adDomain: "example.test",
    });
    expect(recoveryInit?.method).toBeUndefined();
    expect(parseRequestBody(approveInit)).toEqual({
      action: "host-key",
      endpointId: "endpoint-one",
      algorithm: "ssh-ed25519",
      publicKey: "public-key",
      fingerprint: "SHA256:fingerprint",
    });
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector("[data-approve-probe]")).not.toBeNull(),
    );
    element.shadowRoot?.querySelector<HTMLElement>("[data-approve-probe]")?.click();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(6));
    expect(parseRequestBody(fetchImpl.mock.calls[5]?.[1])).toEqual({
      action: "host-key",
      endpointId: "endpoint-one",
      algorithm: "ssh-ed25519",
      publicKey: "public-key",
      fingerprint: "SHA256:fingerprint",
    });
  });

  it("confirms assignment revocation before submitting it", async () => {
    const snapshot = {
      ...SNAPSHOT,
      allocations: [
        {
          id: "allocation-1",
          accountId: "person.one",
          displayName: "Person One",
          vmLabel: "Development VM",
          linuxAccount: "person.one",
          status: "ready" as const,
        },
      ],
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(snapshot));
    mountPlatformClawVmAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-vm-administration")!;
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector("[data-open]")).not.toBeNull());
    element.shadowRoot?.querySelector<HTMLElement>("[data-open]")?.click();
    await vi.waitFor(() =>
      expect(
        element.shadowRoot?.querySelector("[data-mutation='revoke-allocation']"),
      ).not.toBeNull(),
    );

    element.shadowRoot?.querySelector<HTMLElement>("[data-mutation='revoke-allocation']")?.click();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(element.shadowRoot?.querySelector("[data-confirm-mutation]")).not.toBeNull();
    element.shadowRoot?.querySelector<HTMLElement>("[data-confirm-mutation]")?.click();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    const init = fetchImpl.mock.calls[1]?.[1];
    if (typeof init?.body !== "string") {
      throw new Error("revocation request body is missing");
    }
    expect(JSON.parse(init.body)).toEqual({
      action: "revoke-allocation",
      allocationId: "allocation-1",
    });
  });

  it("submits VM-specific PATH and build variables", async () => {
    const snapshot = {
      ...SNAPSHOT,
      hosts: [
        {
          id: "vm-one",
          endpointId: "endpoint-one",
          label: "Development VM",
          targetAddress: "192.0.2.10",
          status: "active" as const,
          executionEnvironment: {
            pathPrepend: ["/opt/old/bin"],
            variables: { OLD_PREFIX: "/opt/old/bin/prefix-" },
          },
        },
      ],
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(snapshot));
    mountPlatformClawVmAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-vm-administration")!;
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector("[data-open]")).not.toBeNull());
    element.shadowRoot?.querySelector<HTMLElement>("[data-open]")?.click();
    await vi.waitFor(() =>
      expect(
        element.shadowRoot?.querySelector("form[data-action='update-host-execution-environment']"),
      ).not.toBeNull(),
    );
    const form = element.shadowRoot?.querySelector<HTMLFormElement>(
      "form[data-action='update-host-execution-environment']",
    );
    if (!form) {
      throw new Error("VM environment form is missing");
    }
    (form.elements.namedItem("pathPrepend") as HTMLTextAreaElement).value =
      "/opt/clang/bin\n/opt/gcc/bin";
    (form.elements.namedItem("environmentVariables") as HTMLTextAreaElement).value =
      "TOOLCHAIN_PREFIX=/opt/gcc/bin/aarch64-elf-\nCLANG11_PATH=/opt/clang/bin/";
    form.requestSubmit();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    expect(parseRequestBody(fetchImpl.mock.calls[1]?.[1])).toEqual({
      action: "update-host-execution-environment",
      vmHostId: "vm-one",
      executionEnvironment: {
        pathPrepend: ["/opt/clang/bin", "/opt/gcc/bin"],
        variables: {
          TOOLCHAIN_PREFIX: "/opt/gcc/bin/aarch64-elf-",
          CLANG11_PATH: "/opt/clang/bin/",
        },
      },
    });
  });

  it("does not reopen after Escape while administration refresh is pending", async () => {
    const pending = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>(() => pending.promise);
    mountPlatformClawVmAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-vm-administration")!;
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector("[data-open]")).not.toBeNull());
    element.shadowRoot?.querySelector<HTMLElement>("[data-open]")?.click();
    const dialog = element.shadowRoot?.querySelector("openclaw-modal-dialog");

    dialog?.dispatchEvent(new Event("modal-cancel"));
    pending.resolve(jsonResponse(SNAPSHOT));

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(element.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
  });
});
