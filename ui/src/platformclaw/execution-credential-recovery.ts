import { renderExecutionCredentialRecovery } from "./execution-credential-recovery-view.ts";
import { executionCredentialUpdateBody } from "./execution-settings-actions.ts";
import {
  executionErrorMessage,
  ExecutionRequestError,
  type ExecutionSettings,
} from "./execution-settings-view.ts";
import {
  notifyPlatformClawExecutionSettingsChanged,
  subscribeToPlatformClawExecutionSettingsChanges,
  subscribeToPlatformClawExecutionTargetChanges,
} from "./execution-target-events.ts";
import { PLATFORMCLAW_EXECUTION_API_PATH } from "./web-contract.ts";

function executionNeedsCredentialRecovery(settings: ExecutionSettings | null): boolean {
  return (
    settings?.activeTarget === "assigned_vm" &&
    settings.credentialStatus === "update_required" &&
    Boolean(settings.assignment)
  );
}

type RecoveryOwner = {
  root: ShadowRoot;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  applySettings(settings: ExecutionSettings): void;
  isBusy(): boolean;
  render(): void;
};

/** Owns one recovery prompt per authoritative allocation/credential failure. */
export class ExecutionCredentialRecovery {
  private settings: ExecutionSettings | null = null;
  private visible = false;
  private acknowledgedFailure = "";
  private error: unknown = null;
  private notice: "saved" | "confirmed" | null = null;
  private stateUnavailable = false;
  private checkingState = false;
  private connected = false;
  private generation = 0;
  private refreshPending = false;
  private unsubscribe = () => {};
  busy = false;

  constructor(private readonly owner: RecoveryOwner) {
    owner.root.addEventListener("click", (event) => {
      const button = event
        .composedPath()
        .find(
          (item): item is HTMLElement =>
            item instanceof HTMLElement && item.hasAttribute("data-recovery-action"),
        );
      if (!button || this.busy) {
        return;
      }
      if (button.dataset.recoveryAction === "retry") {
        void this.refresh();
        return;
      }
      if (button.dataset.recoveryAction === "open") {
        this.visible = true;
        this.error = null;
      } else {
        this.visible = false;
        this.notice = null;
        this.clearInput();
      }
      owner.render();
    });
    owner.root.addEventListener("submit", (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-recovery-credential")) {
        return;
      }
      event.preventDefault();
      const input = form.querySelector<HTMLInputElement>("input[name='password']");
      const password = input?.value ?? "";
      this.clearInput();
      void this.submit(password);
    });
    owner.root.addEventListener("modal-cancel", (event) => {
      if (!(event.target instanceof Element) || !event.target.hasAttribute("data-recovery-modal")) {
        return;
      }
      if (this.busy) {
        event.preventDefault();
        return;
      }
      this.visible = false;
      this.clearInput();
      owner.render();
    });
  }

  connect(): void {
    this.connected = true;
    const unsubscribeSettings = subscribeToPlatformClawExecutionSettingsChanges(
      window,
      () => void this.refresh(),
    );
    const unsubscribeTarget = subscribeToPlatformClawExecutionTargetChanges(
      window,
      () => {
        // A target change retires the old VM authority before its replacement GET.
        this.generation++;
        this.clearInput();
        this.settings = null;
        this.visible = false;
        this.acknowledgedFailure = "";
        this.error = null;
        this.notice = null;
        this.stateUnavailable = false;
        this.checkingState = false;
        this.owner.render();
      },
      () => void this.refresh(),
    );
    this.unsubscribe = () => {
      unsubscribeSettings();
      unsubscribeTarget();
    };
  }

  disconnect(): void {
    this.connected = false;
    this.generation++;
    this.checkingState = false;
    this.unsubscribe();
    this.clearInput();
  }

  observe(settings: ExecutionSettings): void {
    // Any newer owner receipt supersedes a background GET still in flight.
    this.generation++;
    this.stateUnavailable = false;
    this.checkingState = false;
    if (
      this.settings?.activeTarget !== settings.activeTarget ||
      this.settings?.targetRevision !== settings.targetRevision ||
      this.settings?.assignment?.id !== settings.assignment?.id
    ) {
      this.notice = null;
    }
    this.settings = settings;
    if (!executionNeedsCredentialRecovery(settings)) {
      this.visible = false;
      this.clearInput();
      return;
    }
    const failure = JSON.stringify([
      settings.assignment!.id,
      settings.credentialRevision,
      settings.credentialLastAuthFailureAt,
    ]);
    if (failure !== this.acknowledgedFailure) {
      this.clearInput();
      this.acknowledgedFailure = failure;
      this.visible = true;
      this.error = null;
      this.notice = null;
    }
  }

  async refresh(): Promise<void> {
    if (this.busy || this.owner.isBusy()) {
      this.refreshPending = true;
      return;
    }
    this.refreshPending = false;
    const generation = ++this.generation;
    this.checkingState = true;
    this.owner.render();
    try {
      const settings = await this.owner.request<ExecutionSettings>(PLATFORMCLAW_EXECUTION_API_PATH);
      if (this.connected && generation === this.generation) {
        this.owner.applySettings(settings);
        this.owner.render();
      }
    } catch {
      if (this.connected && generation === this.generation) {
        this.checkingState = false;
        this.stateUnavailable = true;
        this.owner.render();
      }
    }
  }

  flush(): void {
    if (this.refreshPending) {
      void this.refresh();
    }
  }

  private clearInput(): void {
    const input = this.owner.root.querySelector<HTMLInputElement>("[data-recovery-password]");
    if (input) {
      input.value = "";
    }
  }

  private async submit(password: string): Promise<void> {
    if (
      this.busy ||
      this.owner.isBusy() ||
      !this.settings ||
      !executionNeedsCredentialRecovery(this.settings)
    ) {
      return;
    }
    if (!password) {
      this.error = new ExecutionRequestError(
        undefined,
        "platformClaw.execution.recoveryPasswordRequired",
      );
      this.owner.render();
      return;
    }
    const generation = ++this.generation;
    const submittedSettings = this.settings;
    this.busy = true;
    this.checkingState = false;
    this.error = null;
    this.notice = null;
    this.owner.render();
    try {
      const settings = await this.owner.request<ExecutionSettings>(
        `${PLATFORMCLAW_EXECUTION_API_PATH}/credential`,
        {
          method: "POST",
          body: JSON.stringify(executionCredentialUpdateBody(submittedSettings, password)),
        },
      );
      if (!this.connected || generation !== this.generation) {
        return;
      }
      this.owner.applySettings(settings);
      this.visible = false;
      this.notice = "saved";
      notifyPlatformClawExecutionSettingsChanged();
    } catch (error) {
      if (this.connected && generation === this.generation) {
        this.error = error;
        // A lost response may follow a committed replacement. Read current owner
        // state before another attempt; never replay the password or old task.
        try {
          const settings = await this.owner.request<ExecutionSettings>(
            PLATFORMCLAW_EXECUTION_API_PATH,
          );
          if (this.connected && generation === this.generation) {
            const confirmed =
              settings.activeTarget === "assigned_vm" &&
              settings.targetRevision === submittedSettings.targetRevision &&
              settings.assignment?.id === submittedSettings.assignment?.id &&
              settings.assignment?.status === "ready" &&
              settings.credentialStatus === "current" &&
              settings.credentialRevision > submittedSettings.credentialRevision;
            this.owner.applySettings(settings);
            if (confirmed) {
              this.notice = "confirmed";
              this.error = null;
            }
          }
        } catch {
          // Keep the visible error and empty input when current state is unavailable.
          if (this.connected && generation === this.generation) {
            this.stateUnavailable = true;
          }
        }
      }
    } finally {
      this.busy = false;
      if (this.connected) {
        this.owner.render();
        this.flush();
      }
    }
  }

  render() {
    return renderExecutionCredentialRecovery({
      settings: this.settings,
      required: executionNeedsCredentialRecovery(this.settings),
      visible: this.visible,
      busy: this.busy || this.owner.isBusy(),
      error: this.error ? executionErrorMessage(this.error) : "",
      notice: this.notice,
      stateUnavailable: this.stateUnavailable,
      checkingState: this.checkingState,
    });
  }
}
