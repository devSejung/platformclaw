import type {
  CodingAgentConfiguration,
  CodingAgentId,
  CodingAgentProbeResult,
} from "@platformclaw/coding-agent-contract";
import {
  CLAUDE_ENVIRONMENT,
  ExecutionRequestError,
  type ExecutionAction,
  type ExecutionActivity,
  type ExecutionSettings,
  type ExecutionTarget,
  type ExecutionTransition,
  type VmSelectionDraft,
} from "./execution-settings-view.ts";

type MutationAction = ExecutionAction | ExecutionTarget;

export const EXECUTION_SETTINGS_ELEMENT_NAME = "platformclaw-execution-settings";

export function executionCredentialUpdateBody(settings: ExecutionSettings, password: string) {
  return {
    password,
    expectedRevision: settings.targetRevision,
    expectedCredentialRevision: settings.credentialRevision,
    expectedAllocationId: settings.assignment?.id,
  };
}

export function mountPlatformClawExecutionSettings(options: {
  fetchImpl: typeof fetch;
  onUnauthenticated: () => void;
}): () => void {
  type SettingsElement = HTMLElement & typeof options;
  const existing = document.querySelector<SettingsElement>(EXECUTION_SETTINGS_ELEMENT_NAME);
  const element =
    existing ?? (document.createElement(EXECUTION_SETTINGS_ELEMENT_NAME) as SettingsElement);
  element.fetchImpl = options.fetchImpl;
  element.onUnauthenticated = options.onUnauthenticated;
  if (!existing) {
    document.body.append(element);
  }
  return () => {
    if (!existing) {
      element.remove();
    }
  };
}

export async function requestExecutionSettings<T>(
  fetchImpl: typeof fetch,
  onUnauthenticated: () => void,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchImpl(path, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...init,
  });
  if (response.status === 401) {
    onUnauthenticated();
    throw new ExecutionRequestError(undefined, "platformClaw.execution.sessionExpired");
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new ExecutionRequestError(body.error, "platformClaw.execution.requestFailed");
  }
  return body as T;
}

export function applyCodingAgentDetection(params: {
  agent: CodingAgentId;
  configuration: CodingAgentConfiguration;
  probe: CodingAgentProbeResult;
  dirty: Set<string>;
  manual: Set<string>;
  errors?: Record<string, string>;
}): CodingAgentConfiguration {
  const { agent, probe, dirty, manual, errors } = params;
  const current = structuredClone(params.configuration);
  if (probe.executablePath && !manual.has("executablePath")) {
    current.executablePath = probe.executablePath;
    dirty.add("executablePath");
    delete errors?.executablePath;
  }
  if (agent === "claude" && current.agent === "claude" && probe.environment) {
    for (const { key } of CLAUDE_ENVIRONMENT) {
      if (!manual.has(key) && probe.environment[key]) {
        current.environment[key] = probe.environment[key];
        dirty.add(key);
        delete errors?.[key];
      }
    }
  }
  return current;
}

export function resolveActiveExecutionConnectionId(
  settings: ExecutionSettings | null,
): string | undefined {
  return settings?.savedVms.find(
    (vm) =>
      vm.vmHostId === settings.assignment?.vmHostId &&
      vm.linuxAccount === settings.assignment?.linuxAccount,
  )?.id;
}

export function resolveExecutionConnectionId(
  settings: ExecutionSettings,
  action: MutationAction,
  connectionId?: string,
): string | undefined {
  return action === "assigned_vm" && !connectionId
    ? resolveActiveExecutionConnectionId(settings)
    : connectionId;
}

export function executionMutationTarget(action: MutationAction): ExecutionTarget | null {
  return action === "selection"
    ? "assigned_vm"
    : action === "assigned_vm" || action === "platform_server"
      ? action
      : null;
}

export function createExecutionTransition(params: {
  settings: ExecutionSettings;
  action: MutationAction;
  selection: VmSelectionDraft | null;
  connectionId?: string;
  retry?: ExecutionTransition;
}): ExecutionTransition | undefined {
  const { settings, action, selection, connectionId, retry } = params;
  const target = executionMutationTarget(action);
  const saved = settings.savedVms.find((vm) => vm.id === connectionId);
  return target
    ? (retry ?? {
        from: {
          target: settings.activeTarget,
          ...(settings.activeTarget === "assigned_vm"
            ? { label: settings.assignment?.vmLabel }
            : {}),
        },
        to: {
          target,
          ...(target === "assigned_vm"
            ? {
                label:
                  action === "selection"
                    ? settings.availableVms.find((vm) => vm.id === selection?.vmHostId)?.label
                    : (saved?.vmLabel ?? settings.assignment?.vmLabel),
                connectionId,
              }
            : {}),
        },
      })
    : undefined;
}

function matchesConnection(settings: ExecutionSettings, connectionId?: string): boolean {
  return (
    !connectionId ||
    settings.savedVms.some(
      (vm) =>
        vm.id === connectionId &&
        vm.vmHostId === settings.assignment?.vmHostId &&
        vm.linuxAccount === settings.assignment?.linuxAccount,
    )
  );
}

export function verifyExecutionTarget(
  settings: ExecutionSettings,
  target: ExecutionTarget,
  connectionId?: string,
): void {
  if (settings.activeTarget !== target || !matchesConnection(settings, connectionId)) {
    throw new ExecutionRequestError(undefined, "platformClaw.execution.switchFailed");
  }
}

export function reconcileExecutionMutation(params: {
  settings: ExecutionSettings | null;
  action: MutationAction;
  previousAssignment: string;
  selection: VmSelectionDraft | null;
  connected: boolean;
  connectionId?: string;
  error: unknown;
  locationUnknown: boolean;
  transition?: ExecutionTransition;
}): ExecutionActivity {
  const {
    settings,
    action,
    previousAssignment,
    selection,
    connectionId,
    error,
    locationUnknown,
    transition,
  } = params;
  const target = executionMutationTarget(action);
  const assignment = settings?.assignment;
  const connected =
    params.connected ||
    Boolean(
      action === "selection" &&
      assignment &&
      assignment.id !== previousAssignment &&
      assignment.vmHostId === selection?.vmHostId &&
      assignment.linuxAccount === selection?.linuxAccount &&
      assignment.status === "ready" &&
      settings?.credentialStatus === "current",
    );
  const released =
    action === "release" &&
    settings &&
    (connectionId ? !settings.savedVms.some((vm) => vm.id === connectionId) : !settings.assignment);
  // Release has an observable end state. Current credentials/ready status can predate
  // a failed save/check, so they cannot prove that particular request succeeded.
  if (
    released ||
    (target &&
      settings?.activeTarget === target &&
      matchesConnection(settings, connectionId) &&
      (action !== "selection" ||
        (connected &&
          settings.assignment?.vmHostId === selection?.vmHostId &&
          settings.assignment?.linuxAccount === selection?.linuxAccount)))
  ) {
    return {
      kind: "success",
      action,
      connection: connected ? "complete" : null,
      target,
      transition,
    };
  }
  return {
    kind: "error",
    action,
    connection: connected ? "complete" : action === "selection" ? "failed" : null,
    error,
    locationUnknown,
    target,
    transition,
  };
}
