/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawModalDialog } from "../components/modal-dialog.ts";
import { i18n } from "../i18n/index.ts";
import { nextFrame } from "../test-helpers/modal-dialog.ts";
import type { ExecutionSettings } from "./execution-settings-view.ts";
import "./execution-credential-recovery-element.ts";
import {
  EXECUTION_SETTINGS,
  deferredExecutionResponse,
  executionSettingsResponse,
} from "./execution-settings.test-support.ts";
import {
  notifyPlatformClawExecutionSettingsChanged,
  notifyPlatformClawExecutionTargetChanged,
} from "./execution-target-events.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";

const FAILURE: ExecutionSettings = {
  ...EXECUTION_SETTINGS,
  activeTarget: "assigned_vm",
  credentialStatus: "update_required",
  credentialRevision: 4,
  credentialLastAuthFailureAt: 1_700_000_100_000,
  assignment: { ...EXECUTION_SETTINGS.assignment, status: "connection_required" },
};
const RECOVERED: ExecutionSettings = {
  ...FAILURE,
  credentialStatus: "current",
  credentialRevision: 5,
  credentialLastAuthFailureAt: undefined,
  assignment: { ...FAILURE.assignment!, status: "ready" },
};

function createRecovery(fetchImpl: typeof fetch) {
  const element = document.createElement("platformclaw-vm-recovery") as HTMLElement & {
    fetchImpl: typeof fetch;
    onUnauthenticated: () => void;
  };
  element.fetchImpl = fetchImpl;
  element.onUnauthenticated = vi.fn();
  document.body.append(element);
  return element.shadowRoot!;
}

async function mountRecovery(fetchImpl: typeof fetch) {
  const root = createRecovery(fetchImpl);
  await vi.waitFor(() =>
    expect(root.querySelector<OpenClawModalDialog>("[data-recovery-modal]")?.open).toBe(true),
  );
  return root;
}

function recoveryModal(root: ShadowRoot) {
  return root.querySelector<OpenClawModalDialog>("[data-recovery-modal]")!;
}

function expectRecoveryClosed(root: ShadowRoot) {
  expect(root.querySelector("[data-recovery-modal]")).toBeNull();
  expect(root.querySelector("[data-recovery-password]")).toBeNull();
}

function submitRecovery(root: ShadowRoot, password: string) {
  const input = root.querySelector<HTMLInputElement>("[data-recovery-password]")!;
  input.value = password;
  root
    .querySelector<HTMLFormElement>("[data-recovery-credential]")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  return input;
}

describe("VM credential recovery", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    await loadPlatformClawLocale();
  });
  afterEach(async () => {
    document.querySelector("platformclaw-vm-recovery")?.remove();
    vi.restoreAllMocks();
    await i18n.setLocale("en");
  });

  it("opens a focused recovery dialog from canonical failure state without opening settings", async () => {
    const root = await mountRecovery(
      vi.fn<typeof fetch>(async () => executionSettingsResponse(FAILURE)),
    );
    expect(recoveryModal(root).textContent).toContain(
      t("platformClaw.execution.recoveryDescription"),
    );
    expect(recoveryModal(root).textContent).toContain("Development VM");
    expect(root.querySelector("[data-settings-modal]")).toBeNull();
    expect(root.querySelector("[data-recovery-password]")?.getAttribute("type")).toBe("password");
  });

  it("keeps Later closed across duplicate updates and reconnects, with an explicit reconnect action", async () => {
    let current: ExecutionSettings = FAILURE;
    const fetchImpl = vi.fn<typeof fetch>(async () => executionSettingsResponse(current));
    const root = await mountRecovery(fetchImpl);
    const input = root.querySelector<HTMLInputElement>("[data-recovery-password]")!;
    input.value = "not-retained";
    root.querySelector<HTMLButtonElement>("[data-recovery-action='later']")!.click();
    expectRecoveryClosed(root);
    expect(input.value).toBe("");
    expect(root.querySelector("[data-recovery-banner]")).not.toBeNull();
    notifyPlatformClawExecutionSettingsChanged();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expectRecoveryClosed(root);
    notifyPlatformClawExecutionSettingsChanged();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expectRecoveryClosed(root);
    root.querySelector<HTMLButtonElement>("[data-recovery-action='open']")!.click();
    expect(recoveryModal(root).open).toBe(true);
    recoveryModal(root).dispatchEvent(
      new CustomEvent("modal-cancel", { bubbles: true, cancelable: true }),
    );
    expectRecoveryClosed(root);
    current = { ...FAILURE, credentialLastAuthFailureAt: 1_700_000_100_001 };
    notifyPlatformClawExecutionSettingsChanged();
    await vi.waitFor(() => expect(recoveryModal(root).open).toBe(true));
  });

  it("preserves typed input across a same-failure refresh and clears it when the allocation changes", async () => {
    let current: ExecutionSettings = FAILURE;
    const fetchImpl = vi.fn<typeof fetch>(async () => executionSettingsResponse(current));
    const root = await mountRecovery(fetchImpl);
    const input = root.querySelector<HTMLInputElement>("[data-recovery-password]")!;
    input.value = "unsubmitted";
    notifyPlatformClawExecutionSettingsChanged();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(root.querySelector("[data-recovery-password]")).toBe(input);
    expect(input.value).toBe("unsubmitted");
    current = { ...FAILURE, assignment: { ...FAILURE.assignment!, id: "allocation-two" } };
    notifyPlatformClawExecutionSettingsChanged();
    await vi.waitFor(() => expect(input.value).toBe(""));
  });

  it.each([
    { dismissed: false, target: "platform_server" },
    { dismissed: true, target: "platform_server" },
    { dismissed: false, target: "assigned_vm" },
    { dismissed: true, target: "assigned_vm" },
  ] as const)(
    "retires old VM recovery immediately after target change: %j",
    async ({ dismissed, target }) => {
      const response = deferredExecutionResponse();
      let changing = false;
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        changing ? await response.promise : executionSettingsResponse(FAILURE),
      );
      const root = await mountRecovery(fetchImpl);
      const input = root.querySelector<HTMLInputElement>("[data-recovery-password]")!;
      input.value = "not-retained";
      if (dismissed) {
        root.querySelector<HTMLButtonElement>("[data-recovery-action='later']")!.click();
      }
      changing = true;
      notifyPlatformClawExecutionTargetChanged();
      expect(input.value).toBe("");
      expectRecoveryClosed(root);
      expect(root.querySelector("[data-recovery-banner]")).toBeNull();
      response.resolve(
        executionSettingsResponse({
          ...FAILURE,
          activeTarget: target,
          targetRevision: FAILURE.targetRevision + 1,
          assignment: { ...FAILURE.assignment!, id: "another-allocation", vmLabel: "Another VM" },
        } satisfies ExecutionSettings),
      );
      if (target === "assigned_vm") {
        await vi.waitFor(() =>
          expect(root.querySelector(".recovery-identity")?.textContent).toContain("Another VM"),
        );
        expect(recoveryModal(root).open).toBe(true);
      } else {
        await nextFrame();
        expectRecoveryClosed(root);
      }
      expect(input.value).toBe("");
    },
  );

  it("keeps retired VM details and input cleared when the new target check fails", async () => {
    let changing = false;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (changing) {
        throw new TypeError("Failed to fetch");
      }
      return executionSettingsResponse(FAILURE);
    });
    const root = await mountRecovery(fetchImpl);
    const input = root.querySelector<HTMLInputElement>("[data-recovery-password]")!;
    input.value = "not-retained";
    changing = true;
    notifyPlatformClawExecutionTargetChanged();
    await vi.waitFor(() =>
      expect(root.querySelector("[data-recovery-state-error]")).not.toBeNull(),
    );
    expectRecoveryClosed(root);
    expect(input.value).toBe("");
    expect(root.querySelector("[data-recovery-banner]")).toBeNull();
  });

  it("sends current revision guards once, clears the secret, and closes after a verified replacement", async () => {
    const response = deferredExecutionResponse();
    let current: ExecutionSettings = FAILURE;
    const fetchImpl = vi.fn<typeof fetch>(async (_path, init) => {
      if (init?.method === "POST") {
        return await response.promise;
      }
      return executionSettingsResponse(current);
    });
    const root = await mountRecovery(fetchImpl);
    const input = submitRecovery(root, "synthetic-password");
    expect(input.value).toBe("");
    submitRecovery(root, "ignored-second-submit");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body = fetchImpl.mock.calls[1]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected a JSON credential request body");
    }
    expect(JSON.parse(body)).toEqual({
      password: "synthetic-password",
      expectedRevision: FAILURE.targetRevision,
      expectedCredentialRevision: 4,
      expectedAllocationId: FAILURE.assignment!.id,
    });
    current = RECOVERED;
    response.resolve(executionSettingsResponse(current));
    await vi.waitFor(() => expectRecoveryClosed(root));
    expect(root.querySelector("[data-recovery-success]")?.textContent).toContain(
      t("platformClaw.execution.recoverySucceeded"),
    );
    expect(root.querySelector("[data-recovery-banner]")).toBeNull();
    expect(input.value).toBe("");
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("keeps rejected passwords out of the DOM and allows another corrected attempt", async () => {
    let rejected = true;
    let current: ExecutionSettings = FAILURE;
    const fetchImpl = vi.fn<typeof fetch>(async (_path, init) => {
      if (init?.method === "POST") {
        if (rejected) {
          return executionSettingsResponse({ error: "AD password was not accepted" }, 422);
        }
        current = RECOVERED;
      }
      return executionSettingsResponse(current);
    });
    const root = await mountRecovery(fetchImpl);
    const input = submitRecovery(root, "synthetic-wrong");
    await vi.waitFor(() =>
      expect(root.querySelector("#execution-recovery-error")?.textContent).toContain(
        t("platformClaw.execution.passwordRejected"),
      ),
    );
    expect(recoveryModal(root).open).toBe(true);
    expect(input.value).toBe("");
    await i18n.setLocale("ko");
    await vi.waitFor(() =>
      expect(root.querySelector("#execution-recovery-error")?.textContent).toContain(
        "AD 비밀번호가 올바르지 않습니다.",
      ),
    );
    rejected = false;
    submitRecovery(root, "synthetic-correct");
    await vi.waitFor(() => expect(root.querySelector("[data-recovery-success]")).not.toBeNull());
  });

  it("reconciles a lost replacement response from owner state without replaying the password", async () => {
    let current: ExecutionSettings = FAILURE;
    const fetchImpl = vi.fn<typeof fetch>(async (_path, init) => {
      if (init?.method === "POST") {
        current = RECOVERED;
        throw new TypeError("Failed to fetch");
      }
      return executionSettingsResponse(current);
    });
    const root = await mountRecovery(fetchImpl);
    submitRecovery(root, "synthetic-password");
    await vi.waitFor(() => expectRecoveryClosed(root));
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(root.querySelector("[data-recovery-success]")?.textContent).toContain(
      t("platformClaw.execution.recoveryConfirmed"),
    );
    expect(root.querySelector("[data-recovery-success]")?.textContent).not.toContain(
      t("platformClaw.execution.recoverySucceeded"),
    );
  });

  it.each([
    { ...RECOVERED, targetRevision: RECOVERED.targetRevision + 1 },
    { ...RECOVERED, assignment: { ...RECOVERED.assignment!, id: "another-allocation" } },
    { ...RECOVERED, credentialRevision: FAILURE.credentialRevision },
    { ...RECOVERED, assignment: { ...RECOVERED.assignment!, status: "connection_required" } },
  ] satisfies ExecutionSettings[])(
    "does not claim recovery when the reconciliation does not confirm the submitted VM",
    async (reconciled) => {
      let current: ExecutionSettings = FAILURE;
      const fetchImpl = vi.fn<typeof fetch>(async (_path, init) => {
        if (init?.method === "POST") {
          current = reconciled;
          throw new TypeError("Failed to fetch");
        }
        return executionSettingsResponse(current);
      });
      const root = await mountRecovery(fetchImpl);
      submitRecovery(root, "synthetic-password");
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expectRecoveryClosed(root));
      expect(root.querySelector("[data-recovery-success]")).toBeNull();
    },
  );

  it("shows a compact retry action when the initial state check fails without opening a password dialog", async () => {
    let unavailable = true;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (unavailable) {
        throw new TypeError("Failed to fetch");
      }
      return executionSettingsResponse(FAILURE);
    });
    const root = createRecovery(fetchImpl);
    await vi.waitFor(() =>
      expect(root.querySelector("[data-recovery-state-error]")?.textContent).toContain(
        t("platformClaw.execution.recoveryStateUnavailable"),
      ),
    );
    expectRecoveryClosed(root);
    unavailable = false;
    root.querySelector<HTMLButtonElement>("[data-recovery-action='retry']")!.click();
    await vi.waitFor(() => expect(recoveryModal(root).open).toBe(true));
    expect(root.querySelector("[data-recovery-state-error]")).toBeNull();
  });

  it("preserves typed input and Later dismissal when a reconnect check fails and is retried", async () => {
    let unavailable = false;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (unavailable) {
        throw new TypeError("Failed to fetch");
      }
      return executionSettingsResponse(FAILURE);
    });
    const root = await mountRecovery(fetchImpl);
    const input = root.querySelector<HTMLInputElement>("[data-recovery-password]")!;
    input.value = "unsubmitted";
    unavailable = true;
    notifyPlatformClawExecutionSettingsChanged();
    await vi.waitFor(() =>
      expect(root.querySelector("[data-recovery-state-error]")).not.toBeNull(),
    );
    expect(recoveryModal(root).open).toBe(true);
    expect(input.value).toBe("unsubmitted");
    root.querySelector<HTMLButtonElement>("[data-recovery-action='later']")!.click();
    expect(input.value).toBe("");
    unavailable = false;
    root.querySelector<HTMLButtonElement>("[data-recovery-action='retry']")!.click();
    await vi.waitFor(() => expect(root.querySelector("[data-recovery-state-error]")).toBeNull());
    expectRecoveryClosed(root);
    expect(root.querySelector("[data-recovery-banner]")).not.toBeNull();
  });

  it.each([
    { ...FAILURE, credentialStatus: "current" },
    { ...FAILURE, activeTarget: "platform_server" },
  ])("does not prompt for non-authentication or inactive VM state", async (settings) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => executionSettingsResponse(settings));
    const element = document.createElement("platformclaw-vm-recovery") as HTMLElement & {
      fetchImpl: typeof fetch;
    };
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    const root = element.shadowRoot!;
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await nextFrame();
    expectRecoveryClosed(root);
  });
});
