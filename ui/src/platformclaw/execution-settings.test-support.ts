import { expect, vi } from "vitest";
import type { ExecutionSettings } from "./execution-settings-view.ts";
import { mountPlatformClawExecutionSettings } from "./execution-settings.ts";

export function executionSettingsResponse(body: unknown, status = 200): Response {
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
export const EXECUTION_SETTINGS = {
  activeTarget: "platform_server",
  targetRevision: 3,
  credentialStatus: "current",
  credentialRevision: 1,
  accountId: "person.one",
  availableVms: [{ id: "vm-one", label: "Development VM" }],
  savedVms: [
    {
      id: "connection-one",
      vmHostId: "vm-one",
      vmLabel: "Development VM",
      safeConnectLabel: "SafeConnect",
      linuxAccount: "person.one",
      status: "ready",
      active: false,
      lastConnectionSucceededAt: 1_700_000_000_000,
    },
  ],
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
      hasSavedConfiguration: false,
      configuration: {
        agent: "claude",
        enabled: false,
        executablePath: "",
        environment: EMPTY_ENVIRONMENT,
      },
    },
    {
      hasSavedConfiguration: false,
      configuration: { agent: "codex", enabled: false, executablePath: "" },
    },
    {
      hasSavedConfiguration: false,
      configuration: { agent: "opencode", enabled: false, executablePath: "" },
    },
  ],
} satisfies ExecutionSettings;
export const UNASSIGNED_EXECUTION_SETTINGS = {
  ...EXECUTION_SETTINGS,
  assignment: undefined,
  savedVms: [],
  credentialStatus: "missing",
};

export function openExecutionSettings(root: ShadowRoot): void {
  root.querySelector<HTMLElement>("[data-action='open']")!.click();
}

export function openCodingAgents(root: ShadowRoot, agent?: "claude" | "codex" | "opencode"): void {
  root.querySelector<HTMLElement>("[data-settings-tab='agents']")!.click();
  if (agent) {
    root.querySelector<HTMLElement>(`[data-agent-expand='${agent}']`)!.click();
  }
}

export function deferredExecutionResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export async function mountExecutionSettings(fetchImpl: typeof fetch): Promise<ShadowRoot> {
  mountPlatformClawExecutionSettings({ fetchImpl, onUnauthenticated: vi.fn() });
  const element = document.querySelector("platformclaw-execution-settings")!;
  await vi.waitFor(() =>
    expect(element.shadowRoot?.querySelector("[data-current-target]")?.textContent).toContain(
      "Basic server",
    ),
  );
  const root = element.shadowRoot!;
  openExecutionSettings(root);
  return root;
}

export function setExecutionInput(root: ShadowRoot, selector: string, value: string): void {
  const input = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export function submitVmSelection(root: ShadowRoot): HTMLFormElement {
  const form = root.querySelector<HTMLFormElement>("[data-action='select-vm']")!;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  return form;
}

export function submitCredentialRenewal(root: ShadowRoot, password: string): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>("[data-password]")!;
  setExecutionInput(root, "[data-password]", password);
  root
    .querySelector<HTMLFormElement>("[data-action='update-credential']")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  return input;
}

export function executionProgressState(
  root: ShadowRoot,
  step: "credential" | "connection" | "activation",
): string | null {
  return (
    root
      .querySelector(`[data-connection-progress] [data-step='${step}']`)
      ?.getAttribute("data-state") ?? null
  );
}

export function expectExecutionControlsDisabled(root: ShadowRoot): void {
  const controls = root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
    "[data-action='select-vm'] input, [data-action='select-vm'] select, [data-action='select-vm'] button, [data-action='update-credential'] input, [data-action='update-credential'] button, [data-target]",
  );
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control.matches(":disabled")).toBe(true);
  }
}
