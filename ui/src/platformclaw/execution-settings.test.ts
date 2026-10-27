import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawModalDialog } from "../components/modal-dialog.ts";
import { i18n } from "../i18n/index.ts";
import { EXECUTION_PROGRESS_SUCCESS_DELAY_MS } from "./execution-settings-shell.ts";
import {
  EXECUTION_SETTINGS,
  UNASSIGNED_EXECUTION_SETTINGS,
  deferredExecutionResponse,
  executionProgressState,
  executionSettingsResponse,
  expectExecutionControlsDisabled,
  mountExecutionSettings,
  setExecutionInput,
  submitVmSelection,
} from "./execution-settings.test-support.ts";
import { mountPlatformClawExecutionSettings } from "./execution-settings.ts";
import { subscribeToPlatformClawExecutionTargetChanges } from "./execution-target-events.ts";
import { platformClawT as t } from "./i18n.ts";

describe("PlatformClaw execution settings", () => {
  afterEach(async () => {
    document.querySelector("platformclaw-execution-settings")?.remove();
    vi.useRealTimers();
    await i18n.setLocale("en");
  });

  it("switches once from the explicit target button and notifies open pages", async () => {
    const changedSettings = {
      ...EXECUTION_SETTINGS,
      activeTarget: "assigned_vm",
      targetRevision: 4,
    };
    const target = deferredExecutionResponse();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(EXECUTION_SETTINGS))
      .mockReturnValueOnce(target.promise);
    const listener = vi.fn();
    const unsubscribe = subscribeToPlatformClawExecutionTargetChanges(window, listener, () => {});
    try {
      const root = await mountExecutionSettings(fetchImpl);
      const switchButton = root.querySelector<HTMLButtonElement>("[data-target='assigned_vm']")!;
      switchButton.click();
      switchButton.click();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[1]).toEqual([
        "/platformclaw/api/execution/target",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            target: "assigned_vm",
            connectionId: "connection-one",
            expectedRevision: 3,
          }),
        }),
      ]);
      expect(root.querySelector("[data-action='confirm-switch']")).toBeNull();
      const progress = root.querySelector<OpenClawModalDialog>("[data-progress-modal]")!;
      expect(progress.open).toBe(true);
      expect(executionProgressState(root, "connection")).toBeNull();
      expect(executionProgressState(root, "activation")).toBe("active");
      expect(progress.textContent).toContain(
        t("platformClaw.execution.switching", { target: "Development VM" }),
      );
      expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("true");
      expect(listener).not.toHaveBeenCalled();

      target.resolve(executionSettingsResponse(changedSettings));

      await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
      expect(root.querySelector("[data-action='open']")?.textContent).toContain("Development VM");
      expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("false");
    } finally {
      unsubscribe();
    }
  });

  it("registers and activates once through the atomic server selection", async () => {
    const selection = deferredExecutionResponse();
    const active = { ...EXECUTION_SETTINGS, activeTarget: "assigned_vm", targetRevision: 4 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(UNASSIGNED_EXECUTION_SETTINGS))
      .mockReturnValueOnce(selection.promise);
    const root = await mountExecutionSettings(fetchImpl);
    setExecutionInput(root, "[name='password']", "fixture-password");
    submitVmSelection(root);
    expect(executionProgressState(root, "connection")).toBe("active");
    expectExecutionControlsDisabled(root);
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        vmHostId: "vm-one",
        linuxAccount: "person.one",
        password: "fixture-password",
        expectedRevision: 3,
      }),
    );
    expect(root.querySelector<HTMLInputElement>("input[name='password']")?.value).toBe("");
    selection.resolve(executionSettingsResponse(active));
    await vi.waitFor(() => expect(executionProgressState(root, "activation")).toBe("complete"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(root.querySelector("[data-current-target]")?.textContent).toContain("Development VM");
  });

  it("resyncs after a failed connection and preserves the selected VM and Linux account", async () => {
    const availableSettings = {
      ...UNASSIGNED_EXECUTION_SETTINGS,
      availableVms: [...EXECUTION_SETTINGS.availableVms, { id: "vm-two", label: "Second VM" }],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(availableSettings))
      .mockResolvedValueOnce(
        executionSettingsResponse({ error: "AD password was not accepted" }, 422),
      )
      .mockResolvedValueOnce(executionSettingsResponse(availableSettings));
    const root = await mountExecutionSettings(fetchImpl);
    setExecutionInput(root, "[name='vmHostId']", "vm-two");
    setExecutionInput(root, "[name='linuxAccount']", "custom.account");
    setExecutionInput(root, "[name='password']", "wrong-password");
    submitVmSelection(root);

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(executionProgressState(root, "connection")).toBe("failed"));
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/selection",
      "/platformclaw/api/execution",
    ]);
    expect(root.querySelector<HTMLSelectElement>("[name='vmHostId']")?.value).toBe("vm-two");
    expect(root.querySelector<HTMLInputElement>("[name='linuxAccount']")?.value).toBe(
      "custom.account",
    );
    expect(root.querySelector("[data-action='open']")?.textContent).toContain("Basic server");
    expect(
      root.querySelector<HTMLButtonElement>("[data-action='select-vm'] button")?.disabled,
    ).toBe(false);
  });

  it("uses the replacement allocation defaults after refreshing an edited VM", async () => {
    const initialSettings = {
      ...EXECUTION_SETTINGS,
      availableVms: [
        ...EXECUTION_SETTINGS.availableVms,
        { id: "vm-two", label: "Draft VM" },
        { id: "vm-three", label: "Replacement VM" },
      ],
    };
    const replacementSettings = {
      ...initialSettings,
      assignment: {
        ...EXECUTION_SETTINGS.assignment,
        id: "allocation-two",
        vmHostId: "vm-three",
        vmLabel: "Replacement VM",
        linuxAccount: "new.account",
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(initialSettings))
      .mockResolvedValueOnce(executionSettingsResponse(replacementSettings));
    const root = await mountExecutionSettings(fetchImpl);
    root.querySelector<HTMLButtonElement>("[data-action='edit-vm']")!.click();
    setExecutionInput(root, "[name='vmHostId']", "vm-two");
    setExecutionInput(root, "[name='linuxAccount']", "stale.account");
    expect(root.querySelector<HTMLSelectElement>("[name='vmHostId']")?.value).toBe("vm-two");
    expect(root.querySelector<HTMLInputElement>("[name='linuxAccount']")?.value).toBe(
      "stale.account",
    );

    root.querySelector<HTMLButtonElement>("[data-action='refresh']")!.click();

    await vi.waitFor(() =>
      expect(root.querySelector("[data-vm-connection] .vm-summary")?.textContent).toContain(
        "new.account",
      ),
    );
    expect(root.querySelector("[data-action='select-vm']")).toBeNull();
    root.querySelector<HTMLButtonElement>("[data-action='edit-vm']")!.click();
    expect(root.querySelector<HTMLSelectElement>("[name='vmHostId']")?.value).toBe("vm-three");
    expect(root.querySelector<HTMLInputElement>("[name='linuxAccount']")?.value).toBe(
      "new.account",
    );
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/platformclaw/api/execution",
      "/platformclaw/api/execution",
    ]);
  });

  it("keeps the exact prior VM when a direct saved-VM switch fails and retries its ID", async () => {
    const first = {
      ...EXECUTION_SETTINGS,
      activeTarget: "assigned_vm",
      savedVms: [
        ...EXECUTION_SETTINGS.savedVms,
        {
          ...EXECUTION_SETTINGS.savedVms[0]!,
          id: "connection-two",
          vmHostId: "vm-two",
          vmLabel: "Second VM",
        },
      ],
    };
    const switched = {
      ...first,
      targetRevision: 4,
      assignment: {
        ...first.assignment,
        id: "allocation-two",
        vmHostId: "vm-two",
        vmLabel: "Second VM",
      },
      savedVms: first.savedVms.map((vm) => ({ ...vm, active: vm.id === "connection-two" })),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(EXECUTION_SETTINGS))
      .mockResolvedValueOnce(executionSettingsResponse(first))
      .mockResolvedValueOnce(executionSettingsResponse({ error: "finish the current task" }, 409))
      .mockResolvedValueOnce(executionSettingsResponse(first))
      .mockResolvedValueOnce(executionSettingsResponse(switched));
    const root = await mountExecutionSettings(fetchImpl);
    root.querySelector<HTMLButtonElement>("[data-action='refresh']")!.click();
    await vi.waitFor(() => expect(root.querySelectorAll("[data-saved-vm]")).toHaveLength(2));
    root.querySelector<HTMLButtonElement>("[data-connection-id='connection-two']")!.click();
    await vi.waitFor(() =>
      expect(root.querySelector("[role='alert']")?.textContent).toContain(
        "finish the current task",
      ),
    );
    expect(root.querySelector("[data-current-target]")?.textContent).toContain("Development VM");
    expect(root.querySelector("[data-progress-panel]")?.textContent).toContain("Second VM");
    root.querySelector<HTMLButtonElement>("[data-action='retry-progress']")!.click();
    await vi.waitFor(() =>
      expect(root.querySelector("[data-current-target]")?.textContent).toContain("Second VM"),
    );
    expect(fetchImpl.mock.calls[4]?.[1]?.body).toBe(
      JSON.stringify({
        target: "assigned_vm",
        connectionId: "connection-two",
        expectedRevision: 3,
      }),
    );
    expect(
      fetchImpl.mock.calls.filter(([input]) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return url.endsWith("/selection");
      }),
    ).toHaveLength(0);
  });

  it("reconciles a lost atomic selection response by exact VM identity", async () => {
    const active = { ...EXECUTION_SETTINGS, activeTarget: "assigned_vm", targetRevision: 4 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(UNASSIGNED_EXECUTION_SETTINGS))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(executionSettingsResponse(active));
    const root = await mountExecutionSettings(fetchImpl);
    setExecutionInput(root, "[name='password']", "fixture-password");
    submitVmSelection(root);
    await vi.waitFor(() =>
      expect(root.querySelector("[data-current-target]")?.textContent).toContain("Development VM"),
    );
    expect(root.querySelector("[role='alert']")).toBeNull();
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/selection",
      "/platformclaw/api/execution",
    ]);
  });

  it.each(["credential", "test"] as const)(
    "keeps %s verification save-only while showing connection progress",
    async (action) => {
      const verification = deferredExecutionResponse();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(executionSettingsResponse(EXECUTION_SETTINGS))
        .mockReturnValueOnce(verification.promise);
      const root = await mountExecutionSettings(fetchImpl);
      if (action === "credential") {
        setExecutionInput(root, "[data-password]", "updated-password");
      }
      root.querySelector<HTMLButtonElement>(`[data-action='${action}']`)!.click();

      const progress = root.querySelector<OpenClawModalDialog>("[data-progress-modal]")!;
      expect(progress.open).toBe(action === "credential");
      const notice =
        action === "credential" ? "[data-progress-modal] .progress-message" : "[data-vm-status]";
      expect(root.querySelector(notice)?.textContent).toContain(
        t("platformClaw.execution.testing"),
      );
      expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("true");
      expectExecutionControlsDisabled(root);
      verification.resolve(executionSettingsResponse(EXECUTION_SETTINGS));

      await vi.waitFor(() =>
        expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("false"),
      );
      expect(root.querySelector(notice)?.textContent).toContain(
        t(
          action === "credential"
            ? "platformClaw.execution.credentialSaved"
            : "platformClaw.execution.connectionTested",
        ),
      );
      expect(root.querySelector("[data-action='open']")?.textContent).toContain("Basic server");
      expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
        "/platformclaw/api/execution",
        `/platformclaw/api/execution/${action}`,
      ]);
      if (action === "credential") {
        expect(root.querySelector("[data-action='activate-verified-vm']")).not.toBeNull();
        root.querySelector<HTMLButtonElement>("[data-action='hide-progress']")!.click();
      }
      fetchImpl
        .mockResolvedValueOnce(
          executionSettingsResponse({ error: "AD password was not accepted" }, 422),
        )
        .mockResolvedValueOnce(executionSettingsResponse(EXECUTION_SETTINGS));
      if (action === "credential") {
        setExecutionInput(root, "[data-password]", "wrong-password");
      }
      root.querySelector<HTMLButtonElement>(`[data-action='${action}']`)!.click();
      await vi.waitFor(() =>
        expect(root.querySelector(`${notice}[role='alert']`)?.textContent).toContain(
          t("platformClaw.execution.passwordRejected"),
        ),
      );
      expect(root.querySelector(`${notice}[role='status']`)).toBeNull();
      expect(progress.open).toBe(action === "credential");
      expect(root.querySelector("[data-action='activate-verified-vm']")).toBeNull();
    },
  );

  it("keeps password renewal in the VM card and accepts re-entry after a rejection without activating", async () => {
    const rejected = deferredExecutionResponse();
    const accepted = deferredExecutionResponse();
    const stale = {
      ...EXECUTION_SETTINGS,
      credentialStatus: "update_required",
      assignment: { ...EXECUTION_SETTINGS.assignment, status: "connection_required" },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(stale))
      .mockReturnValueOnce(rejected.promise)
      .mockResolvedValueOnce(executionSettingsResponse(stale))
      .mockReturnValueOnce(accepted.promise);
    const root = await mountExecutionSettings(fetchImpl);
    const card = root.querySelector("[data-vm-connection]")!;
    const firstInput = card.querySelector<HTMLInputElement>("[data-password]")!;
    expect(firstInput.closest("details, [hidden]")).toBeNull();
    expect(card.querySelectorAll("input[type='password']")).toHaveLength(1);
    expect(card.querySelector("[data-action='select-vm']")).toBeNull();
    setExecutionInput(root, "[data-password]", "rejected-password");
    card
      .querySelector<HTMLFormElement>("[data-action='update-credential']")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(firstInput.value).toBe("");
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ password: "rejected-password" }),
    );
    rejected.resolve(executionSettingsResponse({ error: "AD password was not accepted" }, 422));

    const progress = root.querySelector<OpenClawModalDialog>("[data-progress-modal]")!;
    await vi.waitFor(() =>
      expect(progress.querySelector(".progress-message[role='alert']")?.textContent).toContain(
        t("platformClaw.execution.passwordRejected"),
      ),
    );
    expect(progress.open).toBe(true);
    expect(progress.querySelector("[data-action='activate-verified-vm']")).toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await vi.advanceTimersByTimeAsync(EXECUTION_PROGRESS_SUCCESS_DELAY_MS * 2);
    expect(progress.open).toBe(true);
    root.querySelector<HTMLButtonElement>("[data-action='back-to-settings']")!.click();
    expect(progress.open).toBe(false);
    expect(root.querySelector("[data-vm-status][role='alert']")?.textContent).toContain(
      t("platformClaw.execution.passwordRejected"),
    );
    const renewedCard = root.querySelector("[data-vm-connection]")!;
    const secondInput = renewedCard.querySelector<HTMLInputElement>("[data-password]")!;
    expect(secondInput.value).toBe("");
    expect(secondInput.closest("details, [hidden]")).toBeNull();
    expect(root.querySelectorAll("[data-vm-connection]")).toHaveLength(1);
    setExecutionInput(root, "[data-password]", "corrected-password");
    renewedCard
      .querySelector<HTMLFormElement>("[data-action='update-credential']")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(secondInput.value).toBe("");
    expect(fetchImpl.mock.calls[3]?.[1]?.body).toBe(
      JSON.stringify({ password: "corrected-password" }),
    );
    accepted.resolve(executionSettingsResponse(EXECUTION_SETTINGS));

    await vi.waitFor(() =>
      expect(progress.querySelector(".progress-message[role='status']")?.textContent).toContain(
        t("platformClaw.execution.credentialSaved"),
      ),
    );
    expect(progress.querySelector("[role='alert']")).toBeNull();
    expect(root.querySelector("[data-progress-modal]")).toBe(progress);
    expect(progress.open).toBe(true);
    expect(root.querySelector("[data-action='activate-verified-vm']")).not.toBeNull();
    root.querySelector<HTMLButtonElement>("[data-action='hide-progress']")!.click();
    expect(progress.open).toBe(false);
    expect(root.querySelector("[data-action='open']")?.textContent).toContain("Basic server");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/credential",
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/credential",
    ]);
  });

  it.each(["platform_server", "assigned_vm"] as const)(
    "keeps VM registration available in one connection card while using %s",
    async (activeTarget) => {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        executionSettingsResponse({ ...EXECUTION_SETTINGS, activeTarget }),
      );
      mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
      const root = document.querySelector("platformclaw-execution-settings")!.shadowRoot!;
      await vi.waitFor(() =>
        expect(root.querySelector("[data-action='open']")?.textContent).toContain(
          activeTarget === "assigned_vm" ? "Development VM" : "Basic server",
        ),
      );
      root.querySelector<HTMLButtonElement>("[data-action='open']")!.click();
      expect(root.querySelectorAll("[data-vm-connection]")).toHaveLength(1);
      expect(
        root.querySelector("[data-vm-connection] [data-action='update-credential']"),
      ).not.toBeNull();
      expect(root.querySelector("[data-action='select-vm']")).toBeNull();
      const edit = root.querySelector<HTMLButtonElement>("[data-action='edit-vm']")!;
      expect(edit.disabled).toBe(false);
      edit.click();
      {
        const form = root.querySelector("[data-action='select-vm']")!;
        expect(form.closest("[data-vm-connection]")).not.toBeNull();
        expect(root.querySelectorAll("[data-vm-connection]")).toHaveLength(1);
        expect(root.querySelector("[data-action='update-credential']")).toBeNull();
        root.querySelector<HTMLButtonElement>("[data-action='cancel-edit-vm']")!.click();
        expect(root.querySelector("[data-action='select-vm']")).toBeNull();
        expect(
          root.querySelector("[data-vm-connection] [data-action='update-credential']"),
        ).not.toBeNull();
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("recognizes a released assignment after its response is lost", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(EXECUTION_SETTINGS))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        executionSettingsResponse({
          ...EXECUTION_SETTINGS,
          assignment: undefined,
          savedVms: [],
          credentialStatus: "missing",
          targetRevision: 4,
        }),
      );
    const root = await mountExecutionSettings(fetchImpl);
    root.querySelector<HTMLElement>("[data-vm-connection] details summary")!.click();
    root.querySelector<HTMLButtonElement>("[data-action='release']")!.click();
    root.querySelector<HTMLButtonElement>("[data-action='confirm-release']")!.click();
    await vi.waitFor(() =>
      expect(root.querySelector("[data-vm-status][role='status']")?.textContent).toContain(
        t("platformClaw.execution.vmReleased"),
      ),
    );
    expect(root.querySelector("[role='alert']")).toBeNull();
    expect(root.querySelector("[data-action='release']")).toBeNull();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/release",
      "/platformclaw/api/execution",
    ]);
  });

  it("keeps an Escape-cancelled work-location dialog closed", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      executionSettingsResponse(EXECUTION_SETTINGS),
    );
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-execution-settings")!;
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Basic server"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    const dialog = element.shadowRoot?.querySelector<OpenClawModalDialog>("[data-settings-modal]");

    dialog?.dispatchEvent(
      new CustomEvent("modal-cancel", { bubbles: true, composed: true, cancelable: true }),
    );

    expect(element.shadowRoot?.querySelector("[data-settings-modal]")).toBe(dialog);
    expect(dialog?.open).toBe(false);
  });
});
