import { isCodingAgentId, type CodingAgentId } from "@platformclaw/coding-agent-contract";
import {
  formText,
  type ExecutionTarget,
  type VmSelectionDraft,
} from "./execution-settings-view.ts";

const BUTTON_ACTIONS = [
  "open",
  "close",
  "show-progress",
  "hide-progress",
  "back-to-settings",
  "retry-progress",
  "activate-verified-vm",
  "refresh",
  "test",
  "edit-vm",
  "cancel-edit-vm",
  "release",
  "cancel-release",
  "confirm-release",
] as const;
export type ExecutionSettingsAction =
  | { kind: (typeof BUTTON_ACTIONS)[number] }
  | { kind: "target"; target: ExecutionTarget; connectionId?: string }
  | { kind: "connect-vm"; vmHostId: string }
  | { kind: "configure-vm" | "forget-vm"; connectionId: string }
  | { kind: "tab"; tab: string }
  | { kind: "agent-action"; agent: CodingAgentId; action: "detect" | "check" | "save" | "expand" }
  | { kind: "agent-toggle"; agent: CodingAgentId; enabled: boolean }
  | { kind: "agent-field"; agent: CodingAgentId; field: string; value: string }
  | { kind: "gateway-toggle"; open: boolean }
  | { kind: "credential"; password: string }
  | { kind: "vm-draft"; draft: VmSelectionDraft }
  | { kind: "selection"; draft: VmSelectionDraft; password: string };

function vmDraft(data: FormData): VmSelectionDraft {
  return { vmHostId: formText(data, "vmHostId"), linuxAccount: formText(data, "linuxAccount") };
}

// One delegated listener set survives Lit updates. Rebinding per render would
// duplicate actions whenever an unchanged form remains in its stable dialog.
export function bindExecutionSettingsEvents(
  root: ShadowRoot,
  dispatch: (action: ExecutionSettingsAction) => void,
): void {
  root.addEventListener("click", (event) => {
    const element = event
      .composedPath()
      .find(
        (item): item is HTMLElement =>
          item instanceof HTMLElement &&
          item.matches(
            "[data-action],[data-target],[data-connect-vm],[data-configure-vm],[data-forget-vm],[data-settings-tab],[data-agent-action],[data-agent-quick-save],[data-agent-expand]",
          ),
      );
    if (!element) {
      return;
    }
    const buttonAction = BUTTON_ACTIONS.find((action) => action === element.dataset.action);
    if (buttonAction) {
      dispatch({ kind: buttonAction });
      return;
    }
    const target = element.dataset.target;
    if (target === "platform_server" || target === "assigned_vm") {
      dispatch({
        kind: "target",
        target,
        ...(element.dataset.connectionId ? { connectionId: element.dataset.connectionId } : {}),
      });
      return;
    }
    if (element.dataset.connectVm) {
      dispatch({ kind: "connect-vm", vmHostId: element.dataset.connectVm });
      return;
    }
    if (element.dataset.configureVm || element.dataset.forgetVm) {
      dispatch({
        kind: element.dataset.configureVm ? "configure-vm" : "forget-vm",
        connectionId: element.dataset.configureVm ?? element.dataset.forgetVm!,
      });
      return;
    }
    if (element.dataset.settingsTab) {
      dispatch({ kind: "tab", tab: element.dataset.settingsTab });
      return;
    }
    const [agent, action] = element.dataset.agentAction?.split("-") ?? [];
    if (
      isCodingAgentId(agent) &&
      (action === "detect" || action === "check" || action === "save")
    ) {
      dispatch({ kind: "agent-action", agent, action });
    }
    const expandedAgent = element.dataset.agentExpand;
    if (isCodingAgentId(expandedAgent)) {
      dispatch({ kind: "agent-action", agent: expandedAgent, action: "expand" });
    }
    const savedAgent = element.dataset.agentQuickSave;
    if (isCodingAgentId(savedAgent)) {
      dispatch({ kind: "agent-action", agent: savedAgent, action: "save" });
    }
  });
  root.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) {
      return;
    }
    const form = input.closest<HTMLFormElement>("form[data-action='select-vm']");
    if (form) {
      dispatch({ kind: "vm-draft", draft: vmDraft(new FormData(form)) });
    }
    const agent = input.dataset.agentField?.split("-")[0];
    if (isCodingAgentId(agent)) {
      dispatch({
        kind: "agent-field",
        agent,
        field: input.dataset.field ?? "",
        value: input.value,
      });
    }
  });
  root.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && isCodingAgentId(input.dataset.agentToggle)) {
      dispatch({ kind: "agent-toggle", agent: input.dataset.agentToggle, enabled: input.checked });
    }
  });
  root.addEventListener("submit", (event) => {
    const form = event.target;
    if (
      !(form instanceof HTMLFormElement) ||
      (form.dataset.action !== "select-vm" && form.dataset.action !== "update-credential")
    ) {
      return;
    }
    event.preventDefault();
    const data = new FormData(form);
    const password = formText(data, "password");
    // Capture once, then clear before the controller can rerender the retained form.
    // Secrets stay out of component state and cannot survive a failed submission.
    const passwordInput = form.querySelector<HTMLInputElement>("input[name='password']");
    if (passwordInput) {
      passwordInput.value = "";
    }
    dispatch(
      form.dataset.action === "select-vm"
        ? { kind: "selection", draft: vmDraft(data), password }
        : { kind: "credential", password },
    );
  });
  root.addEventListener("wa-tab-show", (event) =>
    dispatch({ kind: "tab", tab: (event as CustomEvent<{ name: string }>).detail.name }),
  );
  root.addEventListener(
    "toggle",
    (event) => {
      const details = event.target;
      if (details instanceof HTMLDetailsElement && details.hasAttribute("data-claude-gateway")) {
        dispatch({ kind: "gateway-toggle", open: details.open });
      }
    },
    true,
  );
  root.addEventListener("modal-cancel", (event) => {
    if (event.target instanceof Element) {
      dispatch({
        kind: event.target.hasAttribute("data-progress-modal") ? "hide-progress" : "close",
      });
    }
  });
}
