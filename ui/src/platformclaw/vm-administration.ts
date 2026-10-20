import "../components/modal-dialog.ts";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { i18n } from "../i18n/index.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import {
  type VmAdminDialog,
  type VmAdminEndpoint,
  type VmAdminHost,
  type VmAdminMutation,
  type VmAdminOperation,
  type VmAdminSnapshot,
  type VmAdminStage,
  type VmAdminTab,
  type VmEndpointDraft,
  vmEnvironmentDraft,
  vmEnvironmentPayload,
  vmFormString,
  vmHostEditBlock,
  vmMutationBlock,
} from "./vm-administration-model.ts";
import { vmAdministrationStyles } from "./vm-administration-styles.ts";
import {
  renderVmAdministrationDialog,
  renderVmAdministrationPage,
  type VmAdminViewOptions,
} from "./vm-administration-view.ts";
import { PLATFORMCLAW_VM_ADMIN_API_PATH } from "./web-contract.ts";

export const VM_ADMIN_SUCCESS_DELAY_MS = 800;
class VmAdministrationHttpError extends Error {}

class PlatformClawVmAdministrationElement extends OpenClawLitElement {
  static override styles = vmAdministrationStyles;
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => {};
  @state() private snapshot: VmAdminSnapshot | null = null;
  @state() private loading = false;
  @state() private pageError = "";
  @state() private tab: VmAdminTab = "hosts";
  @state() private dialog: VmAdminDialog | null = null;
  @state() private operation: VmAdminOperation = { kind: "idle" };
  @state() private dialogVisible = false;
  private returnFocus: HTMLElement | null = null;
  private generation = 0;
  private unsubscribeLocale?: () => void;
  private successTimer?: ReturnType<typeof setTimeout>;

  override connectedCallback(): void {
    super.connectedCallback();
    // The core locale may finish loading after connection. Load the product
    // override on each locale change too, without rebuilding editors or drafts.
    this.unsubscribeLocale = i18n.subscribe(() => {
      void loadPlatformClawLocale().then(() => {
        if (this.isConnected) {
          this.requestUpdate();
        }
      });
    });
    const generation = this.generation;
    void loadPlatformClawLocale().then(() => {
      if (this.isCurrent(generation)) {
        void this.refresh();
      }
    });
  }

  override disconnectedCallback(): void {
    this.generation++;
    this.unsubscribeLocale?.();
    this.unsubscribeLocale = undefined;
    this.clearSuccessTimer();
    this.dialog = null;
    this.dialogVisible = false;
    this.operation = { kind: "idle" };
    this.loading = false;
    super.disconnectedCallback();
  }

  protected override updated(changes: PropertyValues): void {
    if ((!changes.has("operation") && !changes.has("dialogVisible")) || !this.dialogVisible) {
      return;
    }
    const selector =
      this.operation.kind === "review"
        ? "[data-approve-probe]"
        : this.operation.kind === "error"
          ? ".form-error"
          : null;
    if (selector) {
      this.renderRoot.querySelector<HTMLElement>(selector)?.focus();
    }
  }

  private get busy(): boolean {
    return this.loading || this.operation.kind === "working";
  }
  private isCurrent(generation: number): boolean {
    return this.isConnected && generation === this.generation;
  }
  private clearSuccessTimer(): void {
    clearTimeout(this.successTimer);
    this.successTimer = undefined;
  }

  private async request(
    generation: number,
    body?: Record<string, unknown>,
  ): Promise<VmAdminSnapshot> {
    const response = await this.fetchImpl(PLATFORMCLAW_VM_ADMIN_API_PATH, {
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401) {
      if (this.isCurrent(generation)) {
        this.onUnauthenticated();
      }
      throw new VmAdministrationHttpError(t("platformClaw.execution.sessionExpired"));
    }
    const result = (await response.json()) as VmAdminSnapshot & { error?: string };
    if (!response.ok) {
      throw new VmAdministrationHttpError(result.error ?? t("platformClaw.vmAdmin.requestFailed"));
    }
    return result;
  }

  private async refresh(): Promise<void> {
    if (this.busy) {
      return;
    }
    const generation = ++this.generation;
    this.loading = true;
    this.pageError = "";
    try {
      const snapshot = await this.request(generation);
      if (this.isCurrent(generation)) {
        this.snapshot = snapshot;
      }
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.pageError =
          error instanceof Error ? error.message : t("platformClaw.vmAdmin.requestFailed");
      }
    } finally {
      if (this.isCurrent(generation)) {
        this.loading = false;
      }
    }
  }

  private openDialog(dialog: VmAdminDialog): void {
    if (this.busy) {
      return;
    }
    this.clearSuccessTimer();
    this.returnFocus =
      this.shadowRoot?.activeElement instanceof HTMLElement
        ? this.shadowRoot.activeElement
        : this.renderRoot.querySelector<HTMLElement>("[role='tab'][aria-selected='true']");
    this.pageError = "";
    this.operation = { kind: "idle" };
    this.dialog = dialog;
    this.dialogVisible = true;
  }

  private closeDialog(): void {
    this.dialogVisible = false;
    // Hiding an in-flight operation does not cancel a write or forget an endpoint ID.
    // The same owner and dialog resume through View progress, even after partial commit.
    if (this.operation.kind === "working") {
      return;
    }
    this.clearSuccessTimer();
    this.dialog = null;
    if (this.operation.kind === "review") {
      this.operation = { kind: "idle" };
    }
  }

  private openHost(host?: VmAdminHost): void {
    if (!this.snapshot) {
      return;
    }
    const block = host ? vmHostEditBlock(this.snapshot, host) : null;
    if (block) {
      this.pageError = t(`platformClaw.vmAdmin.${block}`);
      return;
    }
    const endpoints = this.snapshot.endpoints.filter((endpoint) => endpoint.status === "active");
    if (!endpoints.length) {
      return;
    }
    this.openDialog({
      kind: "host",
      hostId: host?.id ?? null,
      draft: {
        ...vmEnvironmentDraft(host),
        endpointId:
          host && endpoints.some((endpoint) => endpoint.id === host.endpointId)
            ? host.endpointId
            : endpoints[0]!.id,
        label: host?.label ?? "",
        targetAddress: host?.targetAddress ?? "",
      },
    });
  }

  private openEndpoint(endpoint?: VmAdminEndpoint): void {
    if (endpoint?.status === "active") {
      return;
    }
    this.openDialog({
      kind: "endpoint",
      probe: null,
      draft: {
        ...(endpoint ? { endpointId: endpoint.id } : {}),
        label: endpoint?.label ?? "",
        host: endpoint?.host ?? "",
        port: endpoint?.port ?? 44_422,
        adDomain: endpoint?.adDomain ?? "",
      },
    });
  }

  private openMutation(mutation: VmAdminMutation): void {
    if (!this.snapshot) {
      return;
    }
    const block = vmMutationBlock(this.snapshot, mutation);
    if (block) {
      this.pageError = t(`platformClaw.vmAdmin.${block}`);
      return;
    }
    this.openDialog({ kind: "confirmation", mutation });
  }

  private updateDraft(event: Event): void {
    if (this.busy || !this.dialog || this.dialog.kind === "confirmation") {
      return;
    }
    const control = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (this.dialog.kind === "endpoint") {
      this.dialog = {
        ...this.dialog,
        draft: {
          ...this.dialog.draft,
          [control.name]: control.name === "port" ? Number(control.value) : control.value,
        },
      };
    } else if (this.dialog.kind === "environment") {
      this.dialog = {
        ...this.dialog,
        draft: { ...this.dialog.draft, [control.name]: control.value },
      };
    } else {
      this.dialog = {
        ...this.dialog,
        draft: { ...this.dialog.draft, [control.name]: control.value },
      };
    }
  }

  private submit(event: SubmitEvent): void {
    event.preventDefault();
    const dialog = this.dialog;
    if (this.busy || !dialog || dialog.kind === "confirmation") {
      return;
    }
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const environment = {
      pathPrepend: vmFormString(data, "pathPrepend"),
      environmentVariables: vmFormString(data, "environmentVariables"),
    };
    if (dialog.kind === "endpoint") {
      const draft = {
        ...dialog.draft,
        label: vmFormString(data, "label"),
        host: vmFormString(data, "host"),
        port: Number(vmFormString(data, "port")),
        adDomain: vmFormString(data, "adDomain"),
      };
      this.dialog = { ...dialog, draft };
      void this.probeEndpoint(draft);
    } else if (dialog.kind === "environment") {
      this.dialog = { ...dialog, draft: environment };
      void this.mutate(
        {
          action: "update-host-execution-environment",
          vmHostId: dialog.host.id,
          executionEnvironment: vmEnvironmentPayload(environment),
        },
        "save-environment",
      );
    } else {
      const draft = {
        ...environment,
        endpointId: vmFormString(data, "endpointId"),
        label: vmFormString(data, "label"),
        targetAddress: vmFormString(data, "targetAddress"),
      };
      this.dialog = { ...dialog, draft };
      void this.mutate(
        {
          action: dialog.hostId ? "update-host" : "hosts",
          ...(dialog.hostId
            ? { vmHostId: dialog.hostId }
            : { executionEnvironment: vmEnvironmentPayload(environment) }),
          endpointId: draft.endpointId,
          label: draft.label,
          targetAddress: draft.targetAddress,
        },
        "save-host",
      );
    }
  }

  private begin(stage: VmAdminStage): number {
    this.clearSuccessTimer();
    this.pageError = "";
    this.operation = { kind: "working", stage };
    return ++this.generation;
  }

  private succeed(stage: VmAdminStage): void {
    const completion: VmAdminOperation = { kind: "success", stage };
    this.operation = completion;
    this.successTimer = setTimeout(() => {
      // Refresh may replace the read generation during this completion dwell.
      // Only a new operation or leaving the page retires this close.
      if (this.isConnected && this.operation === completion) {
        this.dialogVisible = false;
        this.dialog = null;
      }
    }, VM_ADMIN_SUCCESS_DELAY_MS);
  }

  private fail(generation: number, stage: VmAdminStage, error: unknown): void {
    if (this.isCurrent(generation)) {
      this.operation = {
        kind: "error",
        stage,
        error: error instanceof Error ? error.message : t("platformClaw.vmAdmin.requestFailed"),
      };
    }
  }

  private async mutate(body: Record<string, unknown>, stage: VmAdminStage): Promise<void> {
    if (this.busy) {
      return;
    }
    const generation = this.begin(stage);
    try {
      const snapshot = await this.request(generation, body);
      if (!this.isCurrent(generation)) {
        return;
      }
      this.snapshot = snapshot;
      this.succeed(stage);
    } catch (error) {
      this.fail(generation, stage, error);
    }
  }

  private async probeEndpoint(draft: VmEndpointDraft): Promise<void> {
    if (this.busy) {
      return;
    }
    const generation = this.begin("probe");
    try {
      const snapshot = await this.request(generation, {
        action: "probe-endpoint",
        host: draft.host,
        port: draft.port,
      });
      if (!this.isCurrent(generation)) {
        return;
      }
      if (!snapshot.probe) {
        throw new Error(t("platformClaw.vmAdmin.requestFailed"));
      }
      this.snapshot = snapshot;
      this.dialog = { kind: "endpoint", draft, probe: snapshot.probe };
      this.operation = { kind: "review" };
    } catch (error) {
      this.fail(generation, "probe", error);
    }
  }

  private approve(): void {
    const dialog = this.dialog;
    if (this.busy || !dialog) {
      return;
    }
    if (dialog.kind === "endpoint") {
      void this.approveEndpoint(dialog);
    }
    if (dialog.kind === "confirmation") {
      void this.mutate(
        { action: dialog.mutation.action, [dialog.mutation.fieldName]: dialog.mutation.id },
        "change-status",
      );
    }
  }

  private async approveEndpoint(
    dialog: Extract<VmAdminDialog, { kind: "endpoint" }>,
  ): Promise<void> {
    const { draft, probe } = dialog;
    if (!probe) {
      return;
    }
    const generation = this.begin(draft.persisted ? "approve-key" : "save-endpoint");
    let stage: VmAdminStage = draft.persisted ? "approve-key" : "save-endpoint";
    try {
      let endpointId = draft.endpointId;
      // A completed create/update must still belong to this page before approval starts.
      // Keep its assigned ID on the operation so a lost approval response never recreates it.
      if (!draft.persisted) {
        const body = {
          action: endpointId ? "update-endpoint" : "endpoints",
          ...(endpointId ? { endpointId } : {}),
          label: draft.label,
          host: draft.host,
          port: draft.port,
          adDomain: draft.adDomain,
        };
        try {
          const snapshot = await this.request(generation, body);
          if (!this.isCurrent(generation)) {
            return;
          }
          this.snapshot = snapshot;
          endpointId ??= snapshot.endpoints.find(
            (endpoint) => endpoint.host === probe.host && endpoint.port === probe.port,
          )?.id;
        } catch (error) {
          if (!this.isCurrent(generation)) {
            return;
          }
          if (endpointId || error instanceof VmAdministrationHttpError) {
            throw error;
          }
          stage = "recover-endpoint";
          this.operation = { kind: "working", stage };
          try {
            const snapshot = await this.request(generation);
            if (!this.isCurrent(generation)) {
              return;
            }
            this.snapshot = snapshot;
            endpointId = snapshot.endpoints.find(
              (endpoint) => endpoint.host === probe.host && endpoint.port === probe.port,
            )?.id;
          } catch {
            throw error;
          }
          if (!endpointId) {
            throw error;
          }
        }
      }
      if (!endpointId) {
        throw new Error(t("platformClaw.vmAdmin.requestFailed"));
      }
      this.dialog = { kind: "endpoint", draft: { ...draft, endpointId, persisted: true }, probe };
      stage = "approve-key";
      this.operation = { kind: "working", stage };
      const snapshot = await this.request(generation, {
        action: "host-key",
        endpointId,
        algorithm: probe.algorithm,
        publicKey: probe.publicKey,
        fingerprint: probe.fingerprint,
      });
      if (!this.isCurrent(generation)) {
        return;
      }
      this.snapshot = snapshot;
      this.succeed(stage);
    } catch (error) {
      this.fail(generation, stage, error);
    }
  }

  private backToEndpointForm(): void {
    if (this.busy || this.dialog?.kind !== "endpoint") {
      return;
    }
    this.dialog = {
      ...this.dialog,
      draft: { ...this.dialog.draft, persisted: false },
      probe: null,
    };
    this.operation = { kind: "idle" };
  }

  override render() {
    const options: VmAdminViewOptions = {
      snapshot: this.snapshot,
      tab: this.tab,
      loading: this.loading,
      busy: this.busy,
      pageError: this.pageError,
      dialog: this.dialog,
      operation: this.operation,
      dialogVisible: this.dialogVisible,
      returnFocus: this.returnFocus,
      onTab: (tab) => {
        this.tab = tab;
      },
      onRefresh: () => void this.refresh(),
      onHost: (host) => this.openHost(host),
      onEndpoint: (endpoint) => this.openEndpoint(endpoint),
      onEnvironment: (host) =>
        this.openDialog({ kind: "environment", host, draft: vmEnvironmentDraft(host) }),
      onMutation: (mutation) => this.openMutation(mutation),
      onInput: (event) => this.updateDraft(event),
      onSubmit: (event) => this.submit(event),
      onApprove: () => this.approve(),
      onBack: () => this.backToEndpointForm(),
      onClose: () => this.closeDialog(),
      onShow: () => {
        this.dialogVisible = true;
      },
    };
    return html`${renderVmAdministrationPage(options)}${renderVmAdministrationDialog(options)}`;
  }
}

if (!customElements.get("platformclaw-vm-administration")) {
  customElements.define("platformclaw-vm-administration", PlatformClawVmAdministrationElement);
}
