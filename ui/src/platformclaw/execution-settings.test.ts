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
      expect(root.querySelector("[data-action='open']")?.textContent?.trim()).toBe("Work location");
      const switchButton = root.querySelector<HTMLButtonElement>("[data-target='assigned_vm']")!;
      switchButton.click();
      switchButton.click();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[1]).toEqual([
        "/platformclaw/api/execution/target",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ target: "assigned_vm", expectedRevision: 3 }),
        }),
      ]);
      expect(root.querySelector("[data-action='confirm-switch']")).toBeNull();
      const progress = root.querySelector<OpenClawModalDialog>("[data-progress-modal]")!;
      expect(progress.open).toBe(true);
      expect(executionProgressState(root, "connection")).toBeNull();
      expect(executionProgressState(root, "activation")).toBe("active");
      expect(progress.textContent).toContain(
        t("platformClaw.execution.switching", { target: t("platformClaw.execution.vm") }),
      );
      expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("true");
      expect(root.querySelector("[data-action='open']")?.textContent?.trim()).toBe(
        t("platformClaw.execution.switching", { target: t("platformClaw.execution.vm") }),
      );
      expect(listener).not.toHaveBeenCalled();

      target.resolve(executionSettingsResponse(changedSettings));

      await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
      expect(root.querySelector("[data-current-target]")?.textContent).toContain("Development VM");
      expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("false");
      expect(root.querySelector("[data-action='open']")?.textContent?.trim()).toBe("Work location");
    } finally {
      unsubscribe();
    }
  });

  it("connects and activates once, showing only the stage that is actually running", async () => {
    const selection = deferredExecutionResponse();
    const activation = deferredExecutionResponse();
    const selectedSettings = { ...EXECUTION_SETTINGS, targetRevision: 8 };
    const activeSettings = { ...selectedSettings, activeTarget: "assigned_vm", targetRevision: 9 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(UNASSIGNED_EXECUTION_SETTINGS))
      .mockReturnValueOnce(selection.promise)
      .mockReturnValueOnce(activation.promise);
    const listener = vi.fn();
    const unsubscribe = subscribeToPlatformClawExecutionTargetChanges(window, listener, () => {});
    try {
      const root = await mountExecutionSettings(fetchImpl);
      setExecutionInput(root, "[name='password']", "employee-password");
      const password = root.querySelector<HTMLInputElement>(
        "[data-action='select-vm'] [name='password']",
      )!;
      const form = submitVmSelection(root);
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(password.value).toBe("");

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[1]).toEqual([
        "/platformclaw/api/execution/selection",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            vmHostId: "vm-one",
            linuxAccount: "person.one",
            password: "employee-password",
          }),
        }),
      ]);
      expect(root.querySelector("[data-connection-progress]")?.getAttribute("role")).toBe("status");
      expect(executionProgressState(root, "connection")).toBe("active");
      expect(executionProgressState(root, "activation")).toBe("pending");
      expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("true");
      expect(root.querySelector("[data-action='open']")?.textContent?.trim()).toBe(
        t("platformClaw.execution.connecting"),
      );
      expectExecutionControlsDisabled(root);

      selection.resolve(executionSettingsResponse(selectedSettings));

      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
      expect(fetchImpl.mock.calls[2]).toEqual([
        "/platformclaw/api/execution/target",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ target: "assigned_vm", expectedRevision: 8 }),
        }),
      ]);
      expect(executionProgressState(root, "connection")).toBe("complete");
      expect(executionProgressState(root, "activation")).toBe("active");
      expectExecutionControlsDisabled(root);
      expect(root.querySelector("[data-action='open']")?.textContent?.trim()).toBe(
        t("platformClaw.execution.switching", { target: t("platformClaw.execution.vm") }),
      );
      expect(listener).not.toHaveBeenCalled();

      const settings = root.querySelector<OpenClawModalDialog>("[data-settings-modal]")!;
      const progress = root.querySelector<OpenClawModalDialog>("[data-progress-modal]")!;
      root.querySelector<HTMLButtonElement>("[data-action='hide-progress']")!.click();
      expect(progress.open).toBe(false);
      expect(settings.open).toBe(true);
      expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("true");
      root.querySelector<HTMLButtonElement>("[data-action='open']")!.click();
      expect(root.querySelector("[data-progress-modal]")).toBe(progress);
      expect(progress.open).toBe(true);
      expect(executionProgressState(root, "activation")).toBe("active");
      expect(fetchImpl).toHaveBeenCalledTimes(3);

      activation.resolve(executionSettingsResponse(activeSettings));

      await vi.waitFor(() => expect(executionProgressState(root, "activation")).toBe("complete"));
      expect(root.querySelector("[data-current-target]")?.textContent).toContain("Development VM");
      expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("false");
      expect(listener).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      await i18n.setLocale("ko");
      await vi.waitFor(() =>
        expect(
          root.querySelector("[data-progress-modal] .progress-message")?.textContent,
        ).toContain("이제 개발 VM에서 작업합니다."),
      );
      expect(
        root.querySelector("[data-progress-modal] .progress-message")?.textContent,
      ).not.toContain("Now using");
    } finally {
      unsubscribe();
    }
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
    expect(root.querySelector("[data-current-target]")?.textContent).toContain("Basic server");
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

  it("keeps a connected VM available when activation fails and retries only the target change", async () => {
    const selectedSettings = { ...EXECUTION_SETTINGS, targetRevision: 8 };
    const activeSettings = { ...selectedSettings, activeTarget: "assigned_vm", targetRevision: 9 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(UNASSIGNED_EXECUTION_SETTINGS))
      .mockResolvedValueOnce(executionSettingsResponse(selectedSettings))
      .mockResolvedValueOnce(
        executionSettingsResponse(
          { error: "finish the current task before changing work location" },
          409,
        ),
      )
      .mockResolvedValueOnce(executionSettingsResponse(selectedSettings))
      .mockResolvedValueOnce(executionSettingsResponse(activeSettings));
    const root = await mountExecutionSettings(fetchImpl);
    setExecutionInput(root, "[name='password']", "employee-password");
    submitVmSelection(root);

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(executionProgressState(root, "activation")).toBe("failed"));
    expect(executionProgressState(root, "connection")).toBe("complete");
    expect(root.textContent).toContain("VM connected, but the work location could not be changed.");
    await i18n.setLocale("ko");
    await vi.waitFor(() => expect(root.textContent).toContain("VM 연결은 완료됐지만"));
    expect(root.textContent).not.toContain("VM connected, but");
    await i18n.setLocale("en");
    await vi.waitFor(() => expect(root.textContent).toContain("VM connected, but"));
    expect(root.querySelector("[data-current-target]")?.textContent).toContain("Basic server");
    const retry = root.querySelector<HTMLButtonElement>("[data-target='assigned_vm']")!;
    expect(retry.disabled).toBe(false);
    retry.click();

    await vi.waitFor(() =>
      expect(root.querySelector("[data-current-target]")?.textContent).toContain("Development VM"),
    );
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/selection",
      "/platformclaw/api/execution/target",
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/target",
    ]);
    expect(fetchImpl.mock.calls[4]?.[1]?.body).toBe(
      JSON.stringify({ target: "assigned_vm", expectedRevision: 8 }),
    );
  });

  it("reports the actual active VM when the target response is lost after commit", async () => {
    const activeSettings = {
      ...EXECUTION_SETTINGS,
      activeTarget: "assigned_vm",
      targetRevision: 4,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(UNASSIGNED_EXECUTION_SETTINGS))
      .mockResolvedValueOnce(executionSettingsResponse(EXECUTION_SETTINGS))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(executionSettingsResponse(activeSettings));
    const listener = vi.fn();
    const unsubscribe = subscribeToPlatformClawExecutionTargetChanges(window, listener, () => {});
    try {
      const root = await mountExecutionSettings(fetchImpl);
      setExecutionInput(root, "[name='password']", "employee-password");
      submitVmSelection(root);

      await vi.waitFor(() =>
        expect(root.querySelector("[data-current-target]")?.textContent).toContain(
          "Development VM",
        ),
      );
      expect(root.querySelector("[role='alert']")).toBeNull();
      expect(executionProgressState(root, "connection")).toBe("complete");
      expect(executionProgressState(root, "activation")).toBe("complete");
      expect(listener).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
        "/platformclaw/api/execution",
        "/platformclaw/api/execution/selection",
        "/platformclaw/api/execution/target",
        "/platformclaw/api/execution",
      ]);
    } finally {
      unsubscribe();
    }
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
      expect(root.querySelector("[data-action='open']")?.textContent?.trim()).toBe(
        t("platformClaw.execution.testing"),
      );
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
      expect(root.querySelector("[data-current-target]")?.textContent).toContain("Basic server");
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
    expect(root.querySelector("[data-current-target]")?.textContent).toContain("Basic server");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/credential",
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/credential",
    ]);
  });

  it.each(["platform_server", "assigned_vm"] as const)(
    "keeps VM editing in one connection card and guards edits while using %s",
    async (activeTarget) => {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        executionSettingsResponse({ ...EXECUTION_SETTINGS, activeTarget }),
      );
      mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
      const root = document.querySelector("platformclaw-execution-settings")!.shadowRoot!;
      await vi.waitFor(() =>
        expect(root.querySelector("[data-current-target]")?.textContent).toContain(
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
      expect(edit.disabled).toBe(activeTarget === "assigned_vm");
      edit.click();
      if (activeTarget === "platform_server") {
        const form = root.querySelector("[data-action='select-vm']")!;
        expect(form.closest("[data-vm-connection]")).not.toBeNull();
        expect(root.querySelectorAll("[data-vm-connection]")).toHaveLength(1);
        expect(root.querySelector("[data-action='update-credential']")).toBeNull();
        root.querySelector<HTMLButtonElement>("[data-action='cancel-edit-vm']")!.click();
        expect(root.querySelector("[data-action='select-vm']")).toBeNull();
        expect(
          root.querySelector("[data-vm-connection] [data-action='update-credential']"),
        ).not.toBeNull();
      } else {
        expect(root.querySelector("[data-action='select-vm']")).toBeNull();
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
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector("[data-current-target]")?.textContent).toContain(
        "Basic server",
      ),
    );
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    const dialog = element.shadowRoot?.querySelector<OpenClawModalDialog>("[data-settings-modal]");

    dialog?.dispatchEvent(
      new CustomEvent("modal-cancel", { bubbles: true, composed: true, cancelable: true }),
    );

    expect(element.shadowRoot?.querySelector("[data-settings-modal]")).toBe(dialog);
    expect(dialog?.open).toBe(false);
  });
});
