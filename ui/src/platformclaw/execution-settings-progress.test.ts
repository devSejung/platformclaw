/* @vitest-environment jsdom */

import type WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawModalDialog } from "../components/modal-dialog.ts";
import { i18n } from "../i18n/index.ts";
import { installDialogPolyfill, nextFrame } from "../test-helpers/modal-dialog.ts";
import { EXECUTION_PROGRESS_SUCCESS_DELAY_MS } from "./execution-settings-shell.ts";
import {
  EXECUTION_SETTINGS,
  UNASSIGNED_EXECUTION_SETTINGS,
  deferredExecutionResponse,
  executionProgressState,
  executionSettingsResponse,
  mountExecutionSettings,
  openCodingAgents,
  openExecutionSettings,
  setExecutionInput,
  submitCredentialRenewal,
  submitVmSelection,
} from "./execution-settings.test-support.ts";
import { mountPlatformClawExecutionSettings } from "./execution-settings.ts";

async function nativeExecutionModal(root: ShadowRoot, selector: string) {
  const modal = root.querySelector<OpenClawModalDialog>(selector)!;
  expect(modal).toBeInstanceOf(HTMLElement);
  await modal.updateComplete;
  await nextFrame();
  const surface = modal.shadowRoot!.querySelector<WaDialog>("wa-dialog")!;
  await surface.updateComplete;
  await nextFrame();
  const dialog = surface.shadowRoot!.querySelector("dialog")!;
  expect(dialog).toBeInstanceOf(HTMLDialogElement);
  return { modal, surface, dialog };
}

function expectCurrentExecutionLocation(
  settings: HTMLElement,
  activeTarget: "platform_server" | "assigned_vm",
  label: string,
): void {
  const current = settings.querySelector("[data-current-target]")!;
  expect(current.getAttribute("role")).toBe("status");
  expect(current.textContent).toContain(label);
  for (const target of ["platform_server", "assigned_vm"]) {
    const tile = settings.querySelector<HTMLButtonElement>(`[data-target='${target}']`)!;
    expect(tile.getAttribute("aria-pressed")).toBe(String(target === activeTarget));
    expect(tile.disabled).toBe(target === activeTarget);
  }
  expect(settings.querySelector(".message")).toBeNull();
  expect(settings.textContent).not.toContain("Now using");
}

describe("PlatformClaw layered execution progress", () => {
  let restoreDialogPolyfill: () => void;
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
  });
  afterEach(async () => {
    document.querySelector("platformclaw-execution-settings")?.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreDialogPolyfill();
    await i18n.setLocale("en");
  });

  it("updates the same native dialogs and progress list across phases and locales, then dismisses only progress", async () => {
    const selection = deferredExecutionResponse();
    const active = { ...EXECUTION_SETTINGS, activeTarget: "assigned_vm", targetRevision: 4 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(UNASSIGNED_EXECUTION_SETTINGS))
      .mockReturnValueOnce(selection.promise);
    const root = await mountExecutionSettings(fetchImpl);
    const settings = await nativeExecutionModal(root, "[data-settings-modal]");
    const progress = await nativeExecutionModal(root, "[data-progress-modal]");
    const currentLocation = settings.modal.querySelector("[data-current-location]");
    const show = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const close = vi.spyOn(HTMLDialogElement.prototype, "close");
    const focus = vi.spyOn(progress.dialog, "focus");
    setExecutionInput(root, "[name='password']", "employee-password");
    submitVmSelection(root);
    await vi.waitFor(() => expect(progress.dialog.open).toBe(true));
    await nextFrame();
    const initialFocusCount = focus.mock.calls.length;
    const list = progress.modal.querySelector("[data-connection-progress]");
    expect(list).not.toBeNull();
    expect(progress.modal.textContent).toContain("Connecting to the VM");
    expect(progress.modal.textContent).not.toMatch(/[가-힣]/u);
    expect(settings.dialog.open).toBe(true);

    await i18n.setLocale("ko");
    await vi.waitFor(() =>
      expect(progress.modal.textContent).toContain("VM에 연결하고 작업 공간을 준비하고 있습니다"),
    );
    expect(progress.modal.textContent).not.toContain("Connecting to the VM");
    expect(root.querySelector("[data-settings-modal]")).toBe(settings.modal);
    expect(root.querySelector("[data-progress-modal]")).toBe(progress.modal);
    expect(settings.surface.shadowRoot!.querySelector("dialog")).toBe(settings.dialog);
    expect(progress.surface.shadowRoot!.querySelector("dialog")).toBe(progress.dialog);
    expect(progress.modal.querySelector("[data-connection-progress]")).toBe(list);

    // Only the presentation timeout is virtual; request completion stays explicit.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    selection.resolve(executionSettingsResponse(active));
    await vi.waitFor(() => expect(executionProgressState(root, "activation")).toBe("complete"));
    expect(progress.modal.textContent).toContain("이제 Development VM에서 작업합니다.");
    await i18n.setLocale("en");
    await vi.waitFor(() =>
      expect(progress.modal.textContent).toContain("Now using Development VM."),
    );
    expect(progress.modal.textContent).not.toMatch(/[가-힣]/u);
    expect(progress.modal.querySelector("[data-connection-progress]")).toBe(list);
    expect(progress.modal.open).toBe(true);
    expect(show.mock.instances).toEqual([progress.dialog]);
    expect(close).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(initialFocusCount);

    await vi.advanceTimersByTimeAsync(EXECUTION_PROGRESS_SUCCESS_DELAY_MS);
    await vi.waitFor(() => expect(progress.dialog.open).toBe(false));
    expect(progress.modal.open).toBe(false);
    expect(root.querySelector("[data-progress-modal]")).toBe(progress.modal);
    expect(root.querySelector("[data-settings-modal]")).toBe(settings.modal);
    expect(settings.modal.open).toBe(true);
    expect(settings.dialog.open).toBe(true);
    expect(settings.modal.querySelector("[data-current-location]")).toBe(currentLocation);
    expectCurrentExecutionLocation(settings.modal, "assigned_vm", "Development VM");
    expect(close.mock.instances).toEqual([progress.dialog]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("switches directly back to Basic without claiming to connect to a VM", async () => {
    const target = deferredExecutionResponse();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        executionSettingsResponse({ ...EXECUTION_SETTINGS, activeTarget: "assigned_vm" }),
      )
      .mockReturnValueOnce(target.promise);
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const root = document.querySelector("platformclaw-execution-settings")!.shadowRoot!;
    await vi.waitFor(() =>
      expect(root.querySelector("[data-current-target]")?.textContent).toContain("Development VM"),
    );
    openExecutionSettings(root);
    const settings = await nativeExecutionModal(root, "[data-settings-modal]");
    const basicTile = settings.modal.querySelector("[data-target='platform_server']");
    root.querySelector<HTMLButtonElement>("[data-target='platform_server']")!.click();
    const progress = await nativeExecutionModal(root, "[data-progress-modal]");
    expect(progress.modal.open).toBe(true);
    expect(executionProgressState(root, "connection")).toBeNull();
    expect(executionProgressState(root, "activation")).toBe("active");
    expect(progress.modal.textContent).toContain("Basic server");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    target.resolve(executionSettingsResponse({ ...EXECUTION_SETTINGS, targetRevision: 4 }));
    await vi.waitFor(() => expect(executionProgressState(root, "activation")).toBe("complete"));
    expect(progress.modal.textContent).toContain("Now using Basic server.");
    expect(progress.modal.open).toBe(true);
    await vi.advanceTimersByTimeAsync(EXECUTION_PROGRESS_SUCCESS_DELAY_MS);
    await vi.waitFor(() => expect(progress.dialog.open).toBe(false));
    expect(settings.modal.open).toBe(true);
    expect(settings.dialog.open).toBe(true);
    expect(root.querySelector("[data-settings-modal]")).toBe(settings.modal);
    expect(settings.modal.querySelector("[data-target='platform_server']")).toBe(basicTile);
    expectCurrentExecutionLocation(settings.modal, "platform_server", "Basic server");
    expect(root.querySelector("[data-action='open']")?.textContent?.trim()).toBe("Work location");
    expect(fetchImpl.mock.calls[1]).toEqual([
      "/platformclaw/api/execution/target",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ target: "platform_server", expectedRevision: 3 }),
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps verified Basic-server credentials in an open offer until Later without changing the target", async () => {
    const verification = deferredExecutionResponse();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(EXECUTION_SETTINGS))
      .mockReturnValueOnce(verification.promise);
    const root = await mountExecutionSettings(fetchImpl);
    const settings = await nativeExecutionModal(root, "[data-settings-modal]");
    const progress = await nativeExecutionModal(root, "[data-progress-modal]");
    const password = submitCredentialRenewal(root, "updated-password");
    expect(password.value).toBe("");
    expect(progress.modal.open).toBe(true);
    await vi.waitFor(() => expect(progress.dialog.open).toBe(true));
    expect(executionProgressState(root, "credential")).toBe("active");
    expect(executionProgressState(root, "connection")).toBeNull();
    expect(executionProgressState(root, "activation")).toBeNull();
    expect(progress.modal.querySelector<HTMLElement>(".execution-spinner")?.hidden).toBe(false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    verification.resolve(executionSettingsResponse(EXECUTION_SETTINGS));
    await vi.waitFor(() => expect(executionProgressState(root, "credential")).toBe("complete"));
    expect(progress.modal.textContent).toContain("AD password saved and connection verified.");
    expect(progress.modal.textContent).toContain("Use the verified VM as your work location now?");
    await vi.advanceTimersByTimeAsync(EXECUTION_PROGRESS_SUCCESS_DELAY_MS * 2);
    expect(progress.modal.open).toBe(true);
    expect(progress.dialog.open).toBe(true);
    progress.modal
      .querySelector<HTMLButtonElement>(".progress-footer [data-action='hide-progress']")!
      .click();
    await vi.waitFor(() => expect(progress.dialog.open).toBe(false));
    expect(settings.modal.open).toBe(true);
    expect(settings.dialog.open).toBe(true);
    expectCurrentExecutionLocation(settings.modal, "platform_server", "Basic server");
    settings.modal.querySelector<HTMLButtonElement>("[data-action='close']")!.click();
    await vi.waitFor(() => expect(settings.dialog.open).toBe(false));
    root.querySelector<HTMLButtonElement>("[data-action='open']")!.click();
    await vi.waitFor(() => expect(settings.dialog.open).toBe(true));
    expect(progress.modal.open).toBe(false);
    expect(progress.dialog.open).toBe(false);
    expect(root.querySelector("[data-current-target]")?.textContent).toContain("Basic server");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/credential",
    ]);
  });

  it("activates only after accepting the verified-VM offer and retries only the latest target revision", async () => {
    const target = deferredExecutionResponse();
    const retry = deferredExecutionResponse();
    const verified = { ...EXECUTION_SETTINGS, targetRevision: 7 };
    const refreshed = { ...verified, targetRevision: 9 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(EXECUTION_SETTINGS))
      .mockResolvedValueOnce(executionSettingsResponse(verified))
      .mockReturnValueOnce(target.promise)
      .mockResolvedValueOnce(executionSettingsResponse(refreshed))
      .mockReturnValueOnce(retry.promise);
    const root = await mountExecutionSettings(fetchImpl);
    const progress = await nativeExecutionModal(root, "[data-progress-modal]");
    submitCredentialRenewal(root, "updated-password");
    await vi.waitFor(() => expect(executionProgressState(root, "credential")).toBe("complete"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(root.querySelector("[data-current-target]")?.textContent).toContain("Basic server");
    const accept = progress.modal.querySelector<HTMLButtonElement>(
      "[data-action='activate-verified-vm']",
    )!;
    accept.click();
    accept.click();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({
        target: "assigned_vm",
        connectionId: "connection-one",
        expectedRevision: 7,
      }),
    );
    expect(executionProgressState(root, "connection")).toBe("complete");
    expect(executionProgressState(root, "activation")).toBe("active");
    target.resolve(
      executionSettingsResponse(
        { error: "finish the current task before changing work location" },
        409,
      ),
    );
    await vi.waitFor(() => expect(executionProgressState(root, "activation")).toBe("failed"));
    expect(root.querySelector("[data-progress-modal]")).toBe(progress.modal);
    expect(root.querySelector("[data-current-target]")?.textContent).toContain("Basic server");
    const retryButton = progress.modal.querySelector<HTMLButtonElement>(
      "[data-action='retry-progress']",
    )!;
    retryButton.click();
    retryButton.click();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(fetchImpl.mock.calls[4]?.[1]?.body).toBe(
      JSON.stringify({
        target: "assigned_vm",
        connectionId: "connection-one",
        expectedRevision: 9,
      }),
    );
    retry.resolve(
      executionSettingsResponse({ ...refreshed, activeTarget: "assigned_vm", targetRevision: 10 }),
    );
    await vi.waitFor(() => expect(executionProgressState(root, "activation")).toBe("complete"));
    expect(root.querySelector("[data-current-target]")?.textContent).toContain("Development VM");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/credential",
      "/platformclaw/api/execution/target",
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/target",
    ]);
  });

  it("preserves verified connection progress when an approved target response is lost", async () => {
    const reconciliation = deferredExecutionResponse();
    const verified = { ...EXECUTION_SETTINGS, targetRevision: 7 };
    const active = { ...verified, activeTarget: "assigned_vm", targetRevision: 8 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(EXECUTION_SETTINGS))
      .mockResolvedValueOnce(executionSettingsResponse(verified))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockReturnValueOnce(reconciliation.promise);
    const root = await mountExecutionSettings(fetchImpl);
    const settings = await nativeExecutionModal(root, "[data-settings-modal]");
    const progress = await nativeExecutionModal(root, "[data-progress-modal]");
    submitCredentialRenewal(root, "updated-password");
    await vi.waitFor(() => expect(executionProgressState(root, "credential")).toBe("complete"));
    await vi.waitFor(() => expect(progress.dialog.open).toBe(true));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(root.querySelector("[data-current-target]")?.textContent).toContain("Basic server");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    progress.modal
      .querySelector<HTMLButtonElement>("[data-action='activate-verified-vm']")!
      .click();

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    expect(fetchImpl.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({
        target: "assigned_vm",
        connectionId: "connection-one",
        expectedRevision: 7,
      }),
    );
    expect(executionProgressState(root, "connection")).toBe("complete");
    expect(executionProgressState(root, "activation")).toBe("active");
    const panel = progress.modal.querySelector("[data-progress-panel]")!;
    expect(panel.hasAttribute("data-compact")).toBe(false);
    reconciliation.resolve(executionSettingsResponse(active));

    await vi.waitFor(() => expect(executionProgressState(root, "activation")).toBe("complete"));
    expect(executionProgressState(root, "connection")).toBe("complete");
    expect(progress.modal.querySelector("[data-progress-panel]")).toBe(panel);
    expect(panel.hasAttribute("data-compact")).toBe(false);
    expect(progress.modal.querySelector("[role='alert']")).toBeNull();
    expect(progress.modal.textContent).toContain("Now using Development VM.");
    expect(root.querySelector("[data-progress-modal]")).toBe(progress.modal);
    expect(progress.surface.shadowRoot!.querySelector("dialog")).toBe(progress.dialog);
    expect(progress.dialog.open).toBe(true);
    await vi.advanceTimersByTimeAsync(EXECUTION_PROGRESS_SUCCESS_DELAY_MS);
    await vi.waitFor(() => expect(progress.dialog.open).toBe(false));
    expect(settings.dialog.open).toBe(true);
    expectCurrentExecutionLocation(settings.modal, "assigned_vm", "Development VM");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/credential",
      "/platformclaw/api/execution/target",
      "/platformclaw/api/execution",
    ]);
  });

  it("auto-dismisses successful credential verification when the development VM is already active", async () => {
    const verification = deferredExecutionResponse();
    const active = { ...EXECUTION_SETTINGS, activeTarget: "assigned_vm" };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(active))
      .mockReturnValueOnce(verification.promise);
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const root = document.querySelector("platformclaw-execution-settings")!.shadowRoot!;
    await vi.waitFor(() =>
      expect(root.querySelector("[data-current-target]")?.textContent).toContain("Development VM"),
    );
    openExecutionSettings(root);
    const settings = await nativeExecutionModal(root, "[data-settings-modal]");
    const progress = await nativeExecutionModal(root, "[data-progress-modal]");
    submitCredentialRenewal(root, "updated-password");
    await vi.waitFor(() => expect(progress.dialog.open).toBe(true));
    expect(executionProgressState(root, "credential")).toBe("active");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    verification.resolve(executionSettingsResponse(active));
    await vi.waitFor(() => expect(executionProgressState(root, "credential")).toBe("complete"));
    expect(progress.modal.textContent).toContain("AD password saved and connection verified.");
    expect(progress.modal.querySelector("[data-action='activate-verified-vm']")).toBeNull();
    await vi.advanceTimersByTimeAsync(EXECUTION_PROGRESS_SUCCESS_DELAY_MS);
    await vi.waitFor(() => expect(progress.dialog.open).toBe(false));
    expect(settings.modal.open).toBe(true);
    expect(settings.dialog.open).toBe(true);
    expectCurrentExecutionLocation(settings.modal, "assigned_vm", "Development VM");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/credential",
    ]);
  });

  it("keeps the settings native dialog open while coding-agent edits and check results update", async () => {
    const check = deferredExecutionResponse();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(executionSettingsResponse(EXECUTION_SETTINGS))
      .mockReturnValueOnce(check.promise);
    const root = await mountExecutionSettings(fetchImpl);
    const settings = await nativeExecutionModal(root, "[data-settings-modal]");
    const show = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const close = vi.spyOn(HTMLDialogElement.prototype, "close");
    openCodingAgents(root, "opencode");
    setExecutionInput(root, "[data-agent-field='opencode-executablePath']", "/usr/bin/opencode");
    root.querySelector<HTMLButtonElement>("[data-agent-action='opencode-check']")!.click();
    expect(root.querySelector("[data-settings-modal]")).toBe(settings.modal);
    expect(settings.dialog.open).toBe(true);
    check.resolve(
      executionSettingsResponse({
        agent: "opencode",
        executablePath: "/usr/bin/opencode",
        diagnostics: [{ stage: "executable", status: "passed", message: "OpenCode found" }],
      }),
    );
    await vi.waitFor(() => expect(root.textContent).toContain("connection check finished"));
    await nextFrame();
    expect(root.querySelector("[data-settings-modal]")).toBe(settings.modal);
    expect(settings.surface.shadowRoot!.querySelector("dialog")).toBe(settings.dialog);
    expect(settings.dialog.open).toBe(true);
    expect(root.querySelector<OpenClawModalDialog>("[data-progress-modal]")?.open).toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
