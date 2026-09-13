import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { mountPlatformClawExecutionSettings } from "./execution-settings.ts";
import { subscribeToPlatformClawExecutionTargetChanges } from "./execution-target-events.ts";

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

  it("preserves work-location confirmation and revision notification", async () => {
    const changed = { ...SETTINGS, activeTarget: "assigned_vm", targetRevision: 4 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SETTINGS))
      .mockResolvedValueOnce(jsonResponse(changed));
    const listener = vi.fn();
    const unsubscribe = subscribeToPlatformClawExecutionTargetChanges(window, listener, () => {});
    mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
    const root = document.querySelector("platformclaw-execution-settings")!.shadowRoot!;
    await vi.waitFor(() => expect(root.textContent).toContain("Basic workspace"));
    open(root);
    root.querySelector<HTMLElement>("[data-target='assigned_vm']")!.click();
    expect(root.textContent).toContain("Change work location?");
    root.querySelector<HTMLElement>("[data-action='confirm-switch']")!.click();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    unsubscribe();
  });
});
