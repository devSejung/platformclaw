import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { mountPlatformClawExecutionSettings } from "./execution-settings.ts";
import { subscribeToPlatformClawExecutionTargetChanges } from "./execution-target-events.ts";
import { platformClawT as t } from "./i18n.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EMPTY_ENVIRONMENT = {
  ANTHROPIC_BASE_URL: "",
  ADMIN_API_URL: "",
  OIDC_ISSUER_URL: "",
  OIDC_CLIENT_ID: "",
};
const SETTINGS = {
  activeTarget: "platform_server",
  targetRevision: 3,
  credentialStatus: "current",
  accountId: "person.one",
  availableVms: [{ id: "vm-one", label: "Development VM" }],
  assignment: {
    id: "allocation-one",
    vmHostId: "vm-one",
    status: "ready",
    vmLabel: "Development VM",
    safeConnectLabel: "SafeConnect",
    linuxAccount: "person.one",
    remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
    lastConnectionSucceededAt: 1_700_000_000_000,
  },
  codingAgents: [
    {
      configuration: {
        agent: "claude",
        enabled: false,
        executablePath: "",
        environment: EMPTY_ENVIRONMENT,
      },
    },
    { configuration: { agent: "codex", enabled: false, executablePath: "" } },
    { configuration: { agent: "opencode", enabled: false, executablePath: "" } },
  ],
};

function open(root: ShadowRoot): void {
  root.querySelector<HTMLElement>("[data-action='open']")!.click();
}

function openAgents(root: ShadowRoot, agent?: "claude" | "codex" | "opencode"): void {
  root.querySelector<HTMLElement>("[data-settings-tab='agents']")!.click();
  if (agent) {
    root.querySelector<HTMLElement>(`[data-agent-expand='${agent}']`)!.click();
  }
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function openSettings(fetchImpl: typeof fetch): Promise<ShadowRoot> {
  mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
  const element = document.querySelector("platformclaw-execution-settings")!;
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Basic workspace"));
  const root = element.shadowRoot!;
  open(root);
  return root;
}

function inputValue(root: ShadowRoot, selector: string, value: string): void {
  const input = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function submitVm(root: ShadowRoot): HTMLFormElement {
  const form = root.querySelector<HTMLFormElement>("[data-action='select-vm']")!;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  return form;
}

function progressState(root: ShadowRoot, step: "connection" | "activation"): string | null {
  return (
    root
      .querySelector(`[data-connection-progress] [data-step='${step}']`)
      ?.getAttribute("data-state") ?? null
  );
}

function expectSelectionDisabled(root: ShadowRoot): void {
  const controls = root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
    "[data-action='select-vm'] input, [data-action='select-vm'] select, [data-action='select-vm'] button, [data-target]",
  );
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control.matches(":disabled")).toBe(true);
  }
}

describe("PlatformClaw execution settings", () => {
  afterEach(async () => {
    document.querySelector("platformclaw-execution-settings")?.remove();
    await i18n.setLocale("en");
  });

  it("renders an independent, localized use-agent switch for every card", async () => {
    await i18n.setLocale("ko");
    mountPlatformClawExecutionSettings({
      fetchImpl: vi.fn(async () => jsonResponse(SETTINGS)),
      onUnauthenticated: vi.fn(),
    });
    const root = document.querySelector("platformclaw-execution-settings")!.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain("기본 작업 공간"));
    open(root);
    openAgents(root);
    for (const agent of ["claude", "codex", "opencode"]) {
      expect(root.querySelector(`[data-coding-agent='${agent}']`)).not.toBeNull();
      expect(root.querySelector(`[data-agent-toggle='${agent}']`)?.getAttribute("role")).toBe(
        "switch",
      );
    }
    expect(root.querySelector("[data-agent-toggle='claude']")?.getAttribute("aria-label")).toBe(
      "Claude Code 사용 허용",
    );
    expect(root.textContent).toContain("사용 허용");
    expect(root.textContent).toContain("실행 중인 작업은 중지되지 않습니다");
  });

  it("validates literal quotes before enabling Claude and exposes all missing fields", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SETTINGS));
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const root = document.querySelector("platformclaw-execution-settings")!.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain("Basic workspace"));
    open(root);
    openAgents(root, "claude");
    root.querySelector<HTMLInputElement>("[data-agent-field='claude-executablePath']")!.value =
      "/usr/local/bin/claude";
    root
      .querySelector<HTMLInputElement>("[data-agent-field='claude-executablePath']")!
      .dispatchEvent(new Event("input"));
    const quoted = root.querySelector<HTMLInputElement>(
      "[data-agent-field='claude-ANTHROPIC_BASE_URL']",
    )!;
    quoted.value = "'https://gateway.example.test'";
    quoted.dispatchEvent(new Event("input"));
    root.querySelector<HTMLInputElement>("[data-agent-toggle='claude']")!.click();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain("Remove the surrounding quote characters");
    expect(root.textContent).toContain("Gateway admin endpoint is required");
    expect(root.querySelector("[data-claude-gateway]")?.hasAttribute("open")).toBe(true);
  });

  it("detects into an editable preview without overwriting manual draft values or saving", async () => {
    const detected = {
      agent: "claude",
      executablePath: "/opt/claude",
      environment: {
        ANTHROPIC_BASE_URL: "https://detected.example.test",
        ADMIN_API_URL: "https://admin.example.test",
        OIDC_ISSUER_URL: "https://login.example.test",
        OIDC_CLIENT_ID: "detected-client",
      },
      diagnostics: [{ stage: "executable", status: "passed", message: "Claude found" }],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockResolvedValueOnce(jsonResponse(detected))
      .mockResolvedValueOnce(jsonResponse(SETTINGS));
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const root = document.querySelector("platformclaw-execution-settings")!.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain("Basic workspace"));
    open(root);
    openAgents(root, "claude");
    const manual = root.querySelector<HTMLInputElement>(
      "[data-agent-field='claude-OIDC_CLIENT_ID']",
    )!;
    manual.value = "manual-client";
    manual.dispatchEvent(new Event("input"));
    root.querySelector<HTMLElement>("[data-agent-action='claude-detect']")!.click();
    await vi.waitFor(() =>
      expect(
        root.querySelector<HTMLInputElement>("[data-agent-field='claude-executablePath']")?.value,
      ).toBe("/opt/claude"),
    );
    expect(
      root.querySelector<HTMLInputElement>("[data-agent-field='claude-OIDC_CLIENT_ID']")?.value,
    ).toBe("manual-client");
    expect(
      root.querySelector<HTMLInputElement>("[data-agent-field='claude-ADMIN_API_URL']")?.value,
    ).toBe("https://admin.example.test");
    expect(root.textContent).toContain("Detected preview");
    const detectBody = fetchImpl.mock.calls[1]?.[1]?.body;
    if (typeof detectBody !== "string") {
      throw new TypeError("Expected a serialized detect request body");
    }
    expect(JSON.parse(detectBody)).toEqual({
      action: "detect",
      agent: "claude",
      expectedRevision: 3,
    });
    root.querySelector<HTMLElement>("[data-action='refresh']")!.click();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(
      root.querySelector<HTMLInputElement>("[data-agent-field='claude-OIDC_CLIENT_ID']")?.value,
    ).toBe("manual-client");
    expect(
      root.querySelector<HTMLInputElement>("[data-agent-field='claude-ADMIN_API_URL']")?.value,
    ).toBe("https://admin.example.test");
  });

  it("discards drafts when a different allocation reuses the same VM and account", async () => {
    const replacement = {
      ...SETTINGS,
      assignment: { ...SETTINGS.assignment, id: "allocation-two" },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockResolvedValueOnce(jsonResponse(replacement));
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const root = document.querySelector("platformclaw-execution-settings")!.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain("Basic workspace"));
    open(root);
    openAgents(root, "claude");
    const path = root.querySelector<HTMLInputElement>(
      "[data-agent-field='claude-executablePath']",
    )!;
    path.value = "/draft/from-old-allocation";
    path.dispatchEvent(new Event("input"));
    root.querySelector<HTMLElement>("[data-action='refresh']")!.click();
    await vi.waitFor(() =>
      expect(
        root.querySelector<HTMLInputElement>("[data-agent-field='claude-executablePath']")?.value,
      ).toBe(""),
    );
  });

  it("saves one agent without discarding another agent's detected draft", async () => {
    const saved = {
      ...SETTINGS,
      codingAgents: SETTINGS.codingAgents.map((item) =>
        item.configuration.agent === "codex"
          ? { configuration: { agent: "codex", enabled: false, executablePath: "/usr/bin/codex" } }
          : item,
      ),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockResolvedValueOnce(
        jsonResponse({
          agent: "claude",
          executablePath: "/detected/claude",
          diagnostics: [{ stage: "executable", status: "passed", message: "Claude found" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(saved));
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const root = document.querySelector("platformclaw-execution-settings")!.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain("Basic workspace"));
    open(root);
    openAgents(root, "claude");
    root.querySelector<HTMLElement>("[data-agent-expand='codex']")!.click();
    root.querySelector<HTMLElement>("[data-agent-action='claude-detect']")!.click();
    await vi.waitFor(() =>
      expect(
        root.querySelector<HTMLInputElement>("[data-agent-field='claude-executablePath']")?.value,
      ).toBe("/detected/claude"),
    );
    const codex = root.querySelector<HTMLInputElement>(
      "[data-agent-field='codex-executablePath']",
    )!;
    codex.value = "/usr/bin/codex";
    codex.dispatchEvent(new Event("input"));
    root.querySelector<HTMLElement>("[data-agent-action='codex-save']")!.click();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(
      root.querySelector<HTMLInputElement>("[data-agent-field='claude-executablePath']")?.value,
    ).toBe("/detected/claude");
    const saveBody = fetchImpl.mock.calls[2]?.[1]?.body;
    if (typeof saveBody !== "string") {
      throw new TypeError("Expected a serialized save request body");
    }
    expect(JSON.parse(saveBody)).toMatchObject({
      action: "save",
      configuration: { agent: "codex", executablePath: "/usr/bin/codex" },
    });
  });

  it("keeps Save available while stale credentials disable Detect and Check", async () => {
    const stale = {
      ...SETTINGS,
      credentialStatus: "update_required",
      assignment: { ...SETTINGS.assignment, status: "connection_required" },
    };
    mountPlatformClawExecutionSettings({
      fetchImpl: vi.fn(async () => jsonResponse(stale)),
      onUnauthenticated: vi.fn(),
    });
    const root = document.querySelector("platformclaw-execution-settings")!.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain("Basic workspace"));
    open(root);
    openAgents(root, "claude");
    expect(
      root.querySelector<HTMLButtonElement>("[data-agent-action='claude-save']")?.disabled,
    ).toBe(false);
    expect(
      root.querySelector<HTMLButtonElement>("[data-agent-action='claude-detect']")?.disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>("[data-agent-action='claude-check']")?.disabled,
    ).toBe(true);
  });

  it("locks configuration and announces progress while a connection check is pending", async () => {
    let resolveCheck!: (response: Response) => void;
    const checkResponse = new Promise<Response>((resolve) => {
      resolveCheck = resolve;
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockImplementationOnce(() => checkResponse);
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const root = document.querySelector("platformclaw-execution-settings")!.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain("Basic workspace"));
    open(root);
    openAgents(root, "codex");
    const path = root.querySelector<HTMLInputElement>("[data-agent-field='codex-executablePath']")!;
    path.value = "/usr/bin/codex";
    path.dispatchEvent(new Event("input"));
    root.querySelector<HTMLElement>("[data-agent-action='codex-check']")!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("Checking connection…"));
    expect(root.querySelector("[data-coding-agent='codex']")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(
      root.querySelector<HTMLInputElement>("[data-agent-field='codex-executablePath']")?.disabled,
    ).toBe(true);
    resolveCheck(
      jsonResponse({
        agent: "codex",
        executablePath: "/usr/bin/codex",
        diagnostics: [{ stage: "executable", status: "passed", message: "Codex found" }],
      }),
    );
    await vi.waitFor(() => expect(root.textContent).toContain("connection check finished"));
    expect(
      root.querySelector<HTMLInputElement>("[data-agent-field='codex-executablePath']")?.value,
    ).toBe("/usr/bin/codex");
  });

  it("marks saved diagnostics stale after editing and tracks a fresh check time", async () => {
    const withCheck = {
      ...SETTINGS,
      codingAgents: SETTINGS.codingAgents.map((item) =>
        item.configuration.agent === "codex"
          ? {
              configuration: { agent: "codex", enabled: true, executablePath: "/usr/bin/codex" },
              lastCheck: {
                agent: "codex",
                checkedAt: 1_700_000_000_000,
                reportedVersion: "Codex 1",
                diagnostics: [
                  { stage: "executable", status: "passed", message: "Binary found" },
                  { stage: "helper", status: "skipped", message: "Not applicable" },
                  { stage: "acp", status: "skipped", message: "Not checked" },
                ],
              },
            }
          : item,
      ),
    };
    mountPlatformClawExecutionSettings({
      fetchImpl: vi.fn(async () => jsonResponse(withCheck)),
      onUnauthenticated: vi.fn(),
    });
    const root = document.querySelector("platformclaw-execution-settings")!.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain("Basic workspace"));
    open(root);
    openAgents(root, "codex");
    expect(root.textContent).toContain("Installed");
    expect(root.textContent).not.toContain("Connected");
    const path = root.querySelector<HTMLInputElement>("[data-agent-field='codex-executablePath']")!;
    path.value = "/opt/codex";
    path.dispatchEvent(new Event("input"));
    root.querySelector<HTMLInputElement>("[data-agent-toggle='codex']")!.click();
    expect(root.textContent).toContain("Settings changed · check again");
    expect(root.textContent).toContain("Saved permission: on");
    expect(root.textContent).toContain("Unsaved changes");
  });

  it("switches once from the explicit target button and notifies open pages", async () => {
    const changedSettings = { ...SETTINGS, activeTarget: "assigned_vm", targetRevision: 4 };
    const target = deferredResponse();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockReturnValueOnce(target.promise);
    const listener = vi.fn();
    const unsubscribe = subscribeToPlatformClawExecutionTargetChanges(window, listener, () => {});
    try {
      const root = await openSettings(fetchImpl);
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
      expect(root.querySelector("[data-connection-progress]")).toBeNull();
      expect(root.querySelector("[role='status']")?.textContent).toContain(
        t("platformClaw.execution.switching", { target: t("platformClaw.execution.vm") }),
      );
      expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("true");
      expect(listener).not.toHaveBeenCalled();

      target.resolve(jsonResponse(changedSettings));

      await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
      expect(root.querySelector("[data-action='open']")?.textContent).toContain(
        "My development VM",
      );
      expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("false");
    } finally {
      unsubscribe();
    }
  });

  it("connects and activates once, showing only the stage that is actually running", async () => {
    const selection = deferredResponse();
    const activation = deferredResponse();
    const selectedSettings = { ...SETTINGS, targetRevision: 8 };
    const activeSettings = { ...selectedSettings, activeTarget: "assigned_vm", targetRevision: 9 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockReturnValueOnce(selection.promise)
      .mockReturnValueOnce(activation.promise);
    const listener = vi.fn();
    const unsubscribe = subscribeToPlatformClawExecutionTargetChanges(window, listener, () => {});
    try {
      const root = await openSettings(fetchImpl);
      inputValue(root, "[name='password']", "employee-password");
      const form = submitVm(root);
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

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
      expect(progressState(root, "connection")).toBe("active");
      expect(progressState(root, "activation")).toBe("pending");
      expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("true");
      expectSelectionDisabled(root);

      selection.resolve(jsonResponse(selectedSettings));

      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
      expect(fetchImpl.mock.calls[2]).toEqual([
        "/platformclaw/api/execution/target",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ target: "assigned_vm", expectedRevision: 8 }),
        }),
      ]);
      expect(progressState(root, "connection")).toBe("complete");
      expect(progressState(root, "activation")).toBe("active");
      expectSelectionDisabled(root);
      expect(listener).not.toHaveBeenCalled();

      root.querySelector("openclaw-modal-dialog")!.dispatchEvent(new Event("modal-cancel"));
      expect(root.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("true");
      root.querySelector<HTMLButtonElement>("[data-action='open']")!.click();
      expect(progressState(root, "activation")).toBe("active");
      expect(fetchImpl).toHaveBeenCalledTimes(3);

      activation.resolve(jsonResponse(activeSettings));

      await vi.waitFor(() => expect(progressState(root, "activation")).toBe("complete"));
      expect(root.querySelector("[data-action='open']")?.textContent).toContain(
        "My development VM",
      );
      expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("false");
      expect(listener).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      await i18n.setLocale("ko");
      await vi.waitFor(() =>
        expect(root.querySelector(".message--success")?.textContent).toContain(
          t("platformClaw.execution.usingTarget", { target: t("platformClaw.execution.vm") }),
        ),
      );
      expect(root.querySelector(".message--success")?.textContent).not.toContain("Now using");
    } finally {
      unsubscribe();
    }
  });

  it("resyncs after a failed connection and preserves the selected VM and Linux account", async () => {
    const availableSettings = {
      ...SETTINGS,
      availableVms: [...SETTINGS.availableVms, { id: "vm-two", label: "Second VM" }],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(availableSettings))
      .mockResolvedValueOnce(jsonResponse({ error: "AD password was not accepted" }, 422))
      .mockResolvedValueOnce(jsonResponse(availableSettings));
    const root = await openSettings(fetchImpl);
    inputValue(root, "[name='vmHostId']", "vm-two");
    inputValue(root, "[name='linuxAccount']", "custom.account");
    inputValue(root, "[name='password']", "wrong-password");
    submitVm(root);

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(progressState(root, "connection")).toBe("failed"));
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/platformclaw/api/execution",
      "/platformclaw/api/execution/selection",
      "/platformclaw/api/execution",
    ]);
    expect(root.querySelector<HTMLSelectElement>("[name='vmHostId']")?.value).toBe("vm-two");
    expect(root.querySelector<HTMLInputElement>("[name='linuxAccount']")?.value).toBe(
      "custom.account",
    );
    expect(root.querySelector("[data-action='open']")?.textContent).toContain("Basic workspace");
    expect(
      root.querySelector<HTMLButtonElement>("[data-action='select-vm'] button")?.disabled,
    ).toBe(false);
  });

  it("keeps a connected VM available when activation fails and retries only the target change", async () => {
    const selectedSettings = { ...SETTINGS, targetRevision: 8 };
    const activeSettings = { ...selectedSettings, activeTarget: "assigned_vm", targetRevision: 9 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockResolvedValueOnce(jsonResponse(selectedSettings))
      .mockResolvedValueOnce(
        jsonResponse({ error: "finish the current task before changing work location" }, 409),
      )
      .mockResolvedValueOnce(jsonResponse(selectedSettings))
      .mockResolvedValueOnce(jsonResponse(activeSettings));
    const root = await openSettings(fetchImpl);
    inputValue(root, "[name='password']", "employee-password");
    submitVm(root);

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(progressState(root, "activation")).toBe("failed"));
    expect(progressState(root, "connection")).toBe("complete");
    expect(root.textContent).toContain("VM connected, but the work location could not be changed.");
    await i18n.setLocale("ko");
    await vi.waitFor(() => expect(root.textContent).toContain("VM 연결은 완료됐지만"));
    expect(root.textContent).not.toContain("VM connected, but");
    await i18n.setLocale("en");
    await vi.waitFor(() => expect(root.textContent).toContain("VM connected, but"));
    expect(root.querySelector("[data-action='open']")?.textContent).toContain("Basic workspace");
    const retry = root.querySelector<HTMLButtonElement>("[data-target='assigned_vm']")!;
    expect(retry.disabled).toBe(false);
    retry.click();

    await vi.waitFor(() =>
      expect(root.querySelector("[data-action='open']")?.textContent).toContain(
        "My development VM",
      ),
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
    const activeSettings = { ...SETTINGS, activeTarget: "assigned_vm", targetRevision: 4 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse(activeSettings));
    const listener = vi.fn();
    const unsubscribe = subscribeToPlatformClawExecutionTargetChanges(window, listener, () => {});
    try {
      const root = await openSettings(fetchImpl);
      inputValue(root, "[name='password']", "employee-password");
      submitVm(root);

      await vi.waitFor(() =>
        expect(root.querySelector("[data-action='open']")?.textContent).toContain(
          "My development VM",
        ),
      );
      expect(root.querySelector("[role='alert']")).toBeNull();
      expect(progressState(root, "connection")).toBe("complete");
      expect(progressState(root, "activation")).toBe("complete");
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
      const verification = deferredResponse();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(SETTINGS))
        .mockReturnValueOnce(verification.promise);
      const root = await openSettings(fetchImpl);
      if (action === "credential") {
        inputValue(root, "[data-password]", "updated-password");
      }
      root.querySelector<HTMLButtonElement>(`[data-action='${action}']`)!.click();

      expect(root.querySelector("[data-connection-progress]")).toBeNull();
      expect(root.querySelector("[role='status']")?.textContent).toContain(
        t("platformClaw.execution.testing"),
      );
      expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("true");
      expectSelectionDisabled(root);
      verification.resolve(jsonResponse(SETTINGS));

      await vi.waitFor(() =>
        expect(root.querySelector("[data-action='open']")?.getAttribute("aria-busy")).toBe("false"),
      );
      expect(root.querySelector("[role='status']")?.textContent).toContain(
        t("platformClaw.execution.saved"),
      );
      expect(root.querySelector("[data-action='open']")?.textContent).toContain("Basic workspace");
      expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
        "/platformclaw/api/execution",
        `/platformclaw/api/execution/${action}`,
      ]);
      fetchImpl
        .mockResolvedValueOnce(jsonResponse({ error: "AD password was not accepted" }, 422))
        .mockResolvedValueOnce(jsonResponse(SETTINGS));
      if (action === "credential") {
        inputValue(root, "[data-password]", "wrong-password");
      }
      root.querySelector<HTMLButtonElement>(`[data-action='${action}']`)!.click();
      await vi.waitFor(() =>
        expect(root.querySelector("[role='alert']")?.textContent).toContain(
          t("platformClaw.execution.passwordRejected"),
        ),
      );
      expect(root.querySelector(".message--success")).toBeNull();
    },
  );

  it("recognizes a released assignment after its response is lost", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        jsonResponse({
          ...SETTINGS,
          assignment: undefined,
          credentialStatus: "missing",
          targetRevision: 4,
        }),
      );
    const root = await openSettings(fetchImpl);
    root.querySelector<HTMLButtonElement>("[data-action='release']")!.click();
    root.querySelector<HTMLButtonElement>("[data-action='confirm-release']")!.click();
    await vi.waitFor(() =>
      expect(root.querySelector(".message--success")?.textContent).toContain(
        t("platformClaw.execution.saved"),
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
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(SETTINGS));
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-execution-settings")!;
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Basic workspace"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='open']")?.click();
    const dialog = element.shadowRoot?.querySelector("openclaw-modal-dialog");

    dialog?.dispatchEvent(new Event("modal-cancel"));

    expect(element.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
  });
});
