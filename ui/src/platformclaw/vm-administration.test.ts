import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import "./vm-administration.ts";

function mountAdministration(options: { fetchImpl: typeof fetch; onUnauthenticated: () => void }) {
  const element = document.createElement("platformclaw-vm-administration") as HTMLElement & {
    fetchImpl: typeof fetch;
    onUnauthenticated: () => void;
  };
  Object.assign(element, options);
  document.body.append(element);
  return element;
}

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

function click(root: ShadowRoot, selector: string): void {
  const button = root.querySelector<HTMLButtonElement>(selector);
  if (!button) {
    throw new Error(`Missing administration control: ${selector}`);
  }
  button.click();
}

async function openEditor(root: ShadowRoot, selector: string, tab = "hosts") {
  await vi.waitFor(() =>
    expect(root.querySelector(".metric strong")?.textContent).toMatch(/^\d+$/u),
  );
  await vi.waitFor(() =>
    expect(root.querySelector<HTMLButtonElement>("[data-refresh]")?.disabled).toBe(false),
  );
  click(root, `[data-admin-tab='${tab}']`);
  await vi.waitFor(() => expect(root.querySelector(selector)).not.toBeNull());
  click(root, selector);
  await vi.waitFor(() =>
    expect(
      (root.querySelector("[data-admin-modal]") as HTMLElement & { open: boolean })?.open,
    ).toBe(true),
  );
}

describe("PlatformClaw VM administration", () => {
  afterEach(async () => {
    document.querySelector("platformclaw-vm-administration")?.remove();
    vi.useRealTimers();
    await i18n.setLocale("en");
  });

  it("loads the VM overview with a closed editor and no expanded forms", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(SNAPSHOT));
    mountAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-vm-administration")!;

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector<HTMLButtonElement>("[data-refresh]")?.disabled).toBe(
        false,
      ),
    );

    expect(
      element.shadowRoot?.querySelector("[data-admin-tab='hosts'][aria-selected='true']"),
    ).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(
      "/platformclaw/api/admin/vm",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(element.shadowRoot?.querySelectorAll("[role='tab']")).toHaveLength(4);
    expect(element.shadowRoot?.querySelector(".overview")).not.toBeNull();
    expect(
      (element.shadowRoot!.querySelector("[data-admin-modal]") as HTMLElement & { open: boolean })
        .open,
    ).toBe(false);
    expect(element.shadowRoot?.querySelector("form")).toBeNull();
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
    mountAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-vm-administration")!;
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await openEditor(element.shadowRoot!, "[data-add-endpoint]", "endpoints");
    await vi.waitFor(() =>
      expect(
        element.shadowRoot?.querySelector<HTMLInputElement>(
          "form[data-endpoint-probe] input[name='host']",
        )?.disabled,
      ).toBe(false),
    );
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
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector("[data-operation-phase='error']")).not.toBeNull(),
    );
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
    mountAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-vm-administration")!;
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector<HTMLButtonElement>("[data-refresh]")?.disabled).toBe(
        false,
      ),
    );
    click(element.shadowRoot!, "[data-admin-tab='allocations']");
    await vi.waitFor(() =>
      expect(
        element.shadowRoot?.querySelector("[data-mutation='revoke-allocation']"),
      ).not.toBeNull(),
    );

    element.shadowRoot?.querySelector<HTMLElement>("[data-mutation='revoke-allocation']")?.click();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector("[data-confirm-mutation]")).not.toBeNull(),
    );
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
      hosts: ["vm-one", "vm-two"].map((id) => ({
        id,
        endpointId: "endpoint-one",
        label: "Development VM",
        targetAddress: "192.0.2.10",
        status: "active" as const,
        executionEnvironment: {
          pathPrepend: ["/opt/old/bin"],
          variables: { OLD_PREFIX: "/opt/old/bin/prefix-" },
        },
      })),
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(snapshot));
    mountAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-vm-administration")!;
    await openEditor(element.shadowRoot!, "[data-edit-environment='vm-two']");
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
      vmHostId: "vm-two",
      executionEnvironment: {
        pathPrepend: ["/opt/clang/bin", "/opt/gcc/bin"],
        variables: {
          TOOLCHAIN_PREFIX: "/opt/gcc/bin/aarch64-elf-",
          CLANG11_PATH: "/opt/clang/bin/",
        },
      },
    });
  });

  it("ignores an older page load after disconnect and reconnect", async () => {
    const pending = deferred<Response>();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(jsonResponse(SNAPSHOT));
    const element = mountAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    element.remove();
    document.body.append(element);
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector<HTMLButtonElement>("[data-refresh]")?.disabled).toBe(
        false,
      ),
    );
    pending.resolve(
      jsonResponse({
        ...SNAPSHOT,
        endpoints: [
          {
            id: "old",
            label: "Stale endpoint",
            host: "old.test",
            port: 22,
            adDomain: "old",
            status: "active",
          },
        ],
      }),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(element.shadowRoot?.textContent).not.toContain("Stale endpoint");
  });

  it("disables administration controls during a pending page request", async () => {
    const pending = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>(() => pending.promise);
    mountAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const root = document.querySelector("platformclaw-vm-administration")!.shadowRoot!;
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const controls = [
      ...root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
        "[data-add-host], [data-add-endpoint], [data-refresh]",
      ),
    ];
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((control) => control.disabled)).toBe(true);
    root.querySelector<HTMLButtonElement>("[data-refresh]")!.click();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    pending.resolve(jsonResponse(SNAPSHOT));
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLButtonElement>("[data-refresh]")!.disabled).toBe(false),
    );
  });

  it("discards an unconfirmed VM mutation after leaving and returning to the page", async () => {
    const snapshot = {
      ...SNAPSHOT,
      allocations: [
        { id: "a", accountId: "person", vmLabel: "VM", linuxAccount: "person", status: "ready" },
      ],
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(snapshot));
    const element = mountAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const root = element.shadowRoot!;
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLButtonElement>("[data-refresh]")?.disabled).toBe(false),
    );
    click(root, "[data-admin-tab='allocations']");
    await vi.waitFor(() => expect(root.querySelector("[data-mutation]")).not.toBeNull());
    root.querySelector<HTMLButtonElement>("[data-mutation]")!.click();
    await vi.waitFor(() => expect(root.querySelector("[data-confirm-mutation]")).not.toBeNull());
    element.remove();
    document.body.append(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(root.querySelector("[data-confirm-mutation]")).toBeNull();
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("preserves endpoint input through a failed probe and locale rerenders", async () => {
    const pending = deferred<Response>();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SNAPSHOT))
      .mockReturnValueOnce(pending.promise);
    const element = mountAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const root = element.shadowRoot!;
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLButtonElement>("[data-refresh]")?.disabled).toBe(false),
    );
    await openEditor(root, "[data-add-endpoint]", "endpoints");
    for (const [name, value] of Object.entries({
      label: "Draft endpoint",
      host: "draft.test",
      port: "44422",
      adDomain: "draft.domain",
    })) {
      const input = root.querySelector<HTMLInputElement>(
        `form[data-endpoint-probe] [name='${name}']`,
      )!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    root.querySelector<HTMLFormElement>("form[data-endpoint-probe]")!.requestSubmit();
    await i18n.setLocale("ko");
    await loadPlatformClawLocale();
    pending.resolve(jsonResponse({ error: "Probe unavailable" }, 503));
    await vi.waitFor(() =>
      expect(root.querySelector("[role='alert']")?.textContent).toContain("Probe unavailable"),
    );
    expect(root.querySelector<HTMLInputElement>("[name='host']")?.value).toBe("draft.test");
    expect(root.querySelector<HTMLInputElement>("[name='label']")?.value).toBe("Draft endpoint");
    expect(root.querySelector<HTMLInputElement>("[name='adDomain']")?.value).toBe("draft.domain");
    expect(root.querySelector<HTMLInputElement>("[name='host']")?.disabled).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not approve a host key after its endpoint create finishes on a retired page", async () => {
    const create = deferred<Response>();
    const probe = {
      host: "safeconnect.test",
      port: 44422,
      resolvedAddresses: ["192.0.2.20"],
      sshBanner: "SSH-2.0-SafeConnect",
      algorithm: "ssh-ed25519",
      publicKey: "key",
      fingerprint: "SHA256:verified",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SNAPSHOT))
      .mockResolvedValueOnce(jsonResponse({ ...SNAPSHOT, probe }))
      .mockReturnValueOnce(create.promise)
      .mockResolvedValueOnce(jsonResponse(SNAPSHOT));
    const element = mountAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const root = element.shadowRoot!;
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLButtonElement>("[data-refresh]")?.disabled).toBe(false),
    );
    await openEditor(root, "[data-add-endpoint]", "endpoints");
    const form = root.querySelector<HTMLFormElement>("form[data-endpoint-probe]")!;
    for (const [name, value] of Object.entries({
      label: "Access",
      host: probe.host,
      adDomain: "test",
    })) {
      (form.elements.namedItem(name) as HTMLInputElement).value = value;
    }
    form.requestSubmit();
    await vi.waitFor(() => expect(root.querySelector("[data-approve-probe]")).not.toBeNull());
    root.querySelector<HTMLButtonElement>("[data-approve-probe]")!.click();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    element.remove();
    document.body.append(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    create.resolve(
      jsonResponse({
        ...SNAPSHOT,
        endpoints: [
          {
            id: "created",
            label: "Access",
            host: probe.host,
            port: probe.port,
            adDomain: "test",
            status: "pending",
          },
        ],
      }),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(root.querySelector("[data-approve-probe]")).toBeNull();
    expect(
      fetchImpl.mock.calls
        .filter(([, init]) => init?.method === "POST")
        .map(([, init]) => parseRequestBody(init)),
    ).toEqual([
      { action: "probe-endpoint", host: probe.host, port: probe.port },
      {
        action: "endpoints",
        label: "Access",
        host: probe.host,
        port: probe.port,
        adDomain: "test",
      },
    ]);
  });

  it("keeps VM activation unavailable until its parent connection is enabled", async () => {
    const snapshot = {
      ...SNAPSHOT,
      endpoints: [
        {
          id: "endpoint-one",
          label: "Connection",
          host: "access.test",
          port: 22,
          adDomain: "test",
          status: "disabled",
        },
      ],
      hosts: [
        {
          id: "vm-one",
          endpointId: "endpoint-one",
          label: "VM",
          targetAddress: "192.0.2.10",
          status: "disabled",
        },
      ],
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(snapshot));
    const element = mountAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const root = element.shadowRoot!;
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLButtonElement>("[data-refresh]")?.disabled).toBe(false),
    );
    const activate = root.querySelector<HTMLButtonElement>(
      "[data-host-id='vm-one'] [data-mutation='enable-host']",
    )!;
    expect(activate.disabled).toBe(true);
    activate.click();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((root.querySelector("[data-admin-modal]") as HTMLElement & { open: boolean }).open).toBe(
      false,
    );
    expect(root.querySelector<HTMLButtonElement>("[data-edit-host='vm-one']")!.disabled).toBe(true);
    snapshot.endpoints.push({
      id: "endpoint-two",
      label: "Available connection",
      host: "available.test",
      port: 22,
      adDomain: "test",
      status: "active",
    });
    click(root, "[data-refresh]");
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLButtonElement>("[data-edit-host='vm-one']")?.disabled).toBe(
        false,
      ),
    );
    expect(
      root.querySelector<HTMLButtonElement>(
        "[data-host-id='vm-one'] [data-mutation='enable-host']",
      )!.disabled,
    ).toBe(true);
    expect(root.querySelector<HTMLButtonElement>("[data-edit-host='vm-one']")!.disabled).toBe(
      false,
    );
    await openEditor(root, "[data-edit-host='vm-one']");
    const form = root.querySelector<HTMLFormElement>("form[data-action='update-host']")!;
    expect((form.elements.namedItem("endpointId") as HTMLSelectElement).value).toBe("endpoint-two");
    form.requestSubmit();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(parseRequestBody(fetchImpl.mock.calls[2]?.[1])).toEqual({
      action: "update-host",
      vmHostId: "vm-one",
      endpointId: "endpoint-two",
      label: "VM",
      targetAddress: "192.0.2.10",
    });
    await vi.waitFor(() =>
      expect(root.querySelector("[data-operation-phase='success']")).not.toBeNull(),
    );
    click(root, "[data-close-admin]");
    await vi.waitFor(() =>
      expect(
        (root.querySelector("[data-admin-modal]") as HTMLElement & { open: boolean }).open,
      ).toBe(false),
    );
    snapshot.endpoints[0]!.status = "active";
    snapshot.hosts[0]!.endpointId = "endpoint-two";
    click(root, "[data-refresh]");
    await vi.waitFor(() =>
      expect(root.querySelector("[data-host-id='vm-one']")?.textContent).toContain(
        "Available connection",
      ),
    );
    await openEditor(root, "[data-edit-host='vm-one']");
    const select = root.querySelector<HTMLSelectElement>(
      "form[data-action='update-host'] [name='endpointId']",
    )!;
    expect(
      [...select.options].filter((option) => !option.disabled).map((option) => option.value),
    ).toEqual(["endpoint-one", "endpoint-two"]);
    expect(select.value).toBe("endpoint-two");
  });

  it("keeps a hidden connection check pending for explicit key approval", async () => {
    const probe = deferred<Response>();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SNAPSHOT))
      .mockReturnValueOnce(probe.promise);
    const element = mountAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const root = element.shadowRoot!;
    await openEditor(root, "[data-add-endpoint]", "endpoints");
    const form = root.querySelector<HTMLFormElement>("form[data-endpoint-probe]")!;
    for (const [name, value] of Object.entries({
      label: "Access",
      host: "access.test",
      adDomain: "test",
    })) {
      (form.elements.namedItem(name) as HTMLInputElement).value = value;
    }
    form.requestSubmit();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    click(root, "[data-close-admin]");
    const modal = root.querySelector("[data-admin-modal]") as HTMLElement & { open: boolean };
    await vi.waitFor(() => expect(modal.open).toBe(false));
    probe.resolve(
      jsonResponse({
        ...SNAPSHOT,
        probe: {
          host: "access.test",
          port: 44422,
          resolvedAddresses: ["192.0.2.20"],
          sshBanner: "SSH-2.0-Test",
          algorithm: "ssh-ed25519",
          publicKey: "key",
          fingerprint: "SHA256:verified",
        },
      }),
    );
    await vi.waitFor(() =>
      expect(root.querySelector("[data-operation-phase='review']")).not.toBeNull(),
    );
    expect(root.querySelector("[data-view-progress]")).not.toBeNull();
    expect(modal.open).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    click(root, "[data-view-progress]");
    expect(root.querySelector("[data-admin-modal]")).toBe(modal);
    await vi.waitFor(() => expect(modal.open).toBe(true));
    expect(root.querySelector(".probe-facts")?.textContent).toContain("SHA256:verified");
    expect(root.querySelector<HTMLButtonElement>("[data-approve-probe]")!.disabled).toBe(false);
    expect(
      fetchImpl.mock.calls
        .filter(([, init]) => init?.method === "POST")
        .map(([, init]) => parseRequestBody(init)),
    ).toEqual([{ action: "probe-endpoint", host: "access.test", port: 44422 }]);
  });

  it.each([true, false])(
    "clears a completed background save after refresh (reopened: %s)",
    async (reopen) => {
      const save = deferred<Response>();
      const snapshot = {
        ...SNAPSHOT,
        hosts: [
          {
            id: "vm-one",
            endpointId: "endpoint-one",
            label: "VM",
            targetAddress: "192.0.2.10",
            status: "active",
          },
        ],
      };
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(snapshot))
        .mockReturnValueOnce(save.promise)
        .mockResolvedValueOnce(jsonResponse(snapshot));
      const element = mountAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
      const root = element.shadowRoot!;
      await openEditor(root, "[data-edit-environment='vm-one']");
      const modal = root.querySelector("[data-admin-modal]") as HTMLElement & { open: boolean };
      vi.useFakeTimers();
      root
        .querySelector<HTMLFormElement>("form[data-action='update-host-execution-environment']")!
        .requestSubmit();
      expect(root.querySelector("[data-admin-modal]")).toBe(modal);
      await vi.waitFor(() =>
        expect(root.querySelector("[data-stage='save-environment']")).not.toBeNull(),
      );
      expect(root.querySelector<HTMLButtonElement>("[data-close-admin]")!.disabled).toBe(false);
      click(root, "[data-close-admin]");
      await vi.waitFor(() => expect(modal.open).toBe(false));
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      if (reopen) {
        click(root, "[data-view-progress]");
        expect(root.querySelector("[data-admin-modal]")).toBe(modal);
        await vi.waitFor(() => expect(modal.open).toBe(true));
      }
      save.resolve(jsonResponse(snapshot));
      await vi.waitFor(() =>
        expect(root.querySelector("[data-operation-phase='success']")).not.toBeNull(),
      );
      expect(modal.open).toBe(reopen);
      click(root, "[data-refresh]");
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(root.querySelector<HTMLButtonElement>("[data-refresh]")!.disabled).toBe(false);
      await vi.advanceTimersByTimeAsync(800);
      expect(modal.open).toBe(false);
      expect(root.querySelector("[data-view-progress], .admin-dialog")).toBeNull();
      expect(root.querySelector("[data-admin-modal]")).toBe(modal);
    },
  );
});
