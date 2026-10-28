import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../components/icons.ts";
import type { OpenClawModalDialog } from "../components/modal-dialog.ts";
import { platformClawT as t } from "./i18n.ts";
import type {
  VmAdminDialog,
  VmAdminOperation,
  VmAdminSnapshot,
  VmAdminStage,
  VmEnvironmentDraft,
} from "./vm-administration-model.ts";

const copy = (key: string, params?: Record<string, string>) =>
  t(`platformClaw.vmAdmin.${key}`, params);

export type VmAdminDialogViewOptions = {
  snapshot: VmAdminSnapshot | null;
  busy: boolean;
  dialog: VmAdminDialog | null;
  operation: VmAdminOperation;
  dialogVisible: boolean;
  returnFocus: HTMLElement | null;
  onInput: (event: Event) => void;
  onSubmit: (event: SubmitEvent) => void;
  onApprove: () => void;
  onBack: () => void;
  onClose: () => void;
};

const stageKeys: Record<VmAdminStage, string> = {
  "rename-endpoint": "stageRenameEndpoint",
  probe: "stageProbe",
  "save-endpoint": "stageSaveEndpoint",
  "recover-endpoint": "stageRecoverEndpoint",
  "approve-key": "stageApproveKey",
  "save-host": "stageSaveHost",
  "save-environment": "stageSaveEnvironment",
  "change-status": "stageChangeStatus",
};

export function vmAdminStageLabel(stage: VmAdminStage): string {
  return copy(stageKeys[stage]);
}

function vmAdminDialogTitle(dialog: VmAdminDialog | null): string {
  if (!dialog) {
    return copy("title");
  }
  return dialog.kind === "rename-endpoint"
    ? copy("renameEndpoint")
    : dialog.kind === "endpoint"
      ? copy(dialog.draft.endpointId ? "editAndVerify" : "createEndpoint")
      : dialog.kind === "environment"
        ? copy("executionEnvironment")
        : dialog.kind === "confirmation"
          ? copy("confirmTitle")
          : copy(dialog.hostId ? "edit" : "createHost");
}

function environmentFields(
  draft: VmEnvironmentDraft,
  onInput: (event: Event) => void,
): TemplateResult {
  return html`<p class="muted small">${copy("executionEnvironmentHelp")}</p>
    <label
      >${copy("pathPrepend")}<textarea
        name="pathPrepend"
        autofocus
        .value=${draft.pathPrepend}
        @input=${onInput}
        placeholder="/opt/toolchain/bin"
      ></textarea></label
    ><label
      >${copy("environmentVariables")}<textarea
        name="environmentVariables"
        .value=${draft.environmentVariables}
        @input=${onInput}
        placeholder="TOOLCHAIN_PREFIX=/opt/toolchain/bin/prefix-"
      ></textarea>
    </label>
    <p class="muted small">${copy("environmentVariablesHelp")}</p>`;
}

function renderProgress(operation: VmAdminOperation) {
  if (operation.kind === "idle" || operation.kind === "review") {
    return nothing;
  }
  return html`<div
    class="progress"
    data-admin-progress
    data-stage=${operation.stage}
    data-outcome=${operation.kind}
    role="status"
    aria-live="polite"
  >
    <div class="flow" aria-hidden="true">
      <span class="flow-server">${icons.server}${copy("administration")}</span
      ><span class="flow-link"
        ><span class="flow-track"></span><span class="flow-packet"></span
        ><span class="flow-orb"
          >${operation.kind === "working"
            ? html`<span class="spinner"></span>`
            : operation.kind === "success"
              ? icons.check
              : icons.x}</span
        ></span
      ><span class="flow-server"
        >${operation.stage === "probe" || operation.stage === "approve-key"
          ? icons.shieldCheck
          : icons.server}${copy(
          operation.stage === "probe" || operation.stage === "approve-key"
            ? "endpoint"
            : "configuration",
        )}</span
      >
    </div>
    <p>
      ${copy(
        operation.kind === "success"
          ? operation.stage === "rename-endpoint"
            ? "endpointRenamed"
            : "saved"
          : operation.kind === "error"
            ? "operationFailed"
            : stageKeys[operation.stage],
      )}
    </p>
    ${operation.kind === "working" ? html`<p class="small">${copy("backgroundWork")}</p>` : nothing}
  </div>`;
}

function renderEditor(options: VmAdminDialogViewOptions, dialog: VmAdminDialog) {
  const operation = options.operation;
  const workingOrSuccess = operation.kind === "working" || operation.kind === "success";
  if (dialog.kind === "rename-endpoint") {
    return html`<form
      data-rename-endpoint-form
      ?hidden=${workingOrSuccess}
      @submit=${options.onSubmit}
    >
      <fieldset ?disabled=${options.busy}>
        <label
          >${copy("label")}<input
            name="label"
            .value=${dialog.draft.label}
            @input=${options.onInput}
            required
            maxlength="200"
            autofocus
        /></label>
        <p class="muted small">${copy("renameEndpointHelp")}</p>
        <div class="dialog-footer">
          <button type="button" @click=${options.onClose}>${copy("cancel")}</button
          ><button class="primary">${copy("saveChanges")}</button>
        </div>
      </fieldset>
    </form>`;
  }
  if (dialog.kind === "confirmation") {
    return html`<section ?hidden=${workingOrSuccess}>
      <p>
        ${copy(
          dialog.mutation.action === "disable-endpoint"
            ? "confirmDisableEndpoint"
            : dialog.mutation.action === "disable-host"
              ? "confirmDisableHost"
              : dialog.mutation.action === "revoke-saved-connection"
                ? "confirmRevokeSaved"
                : dialog.mutation.action === "revoke-allocation"
                  ? "confirmRevoke"
                  : dialog.mutation.action === "enable-endpoint"
                    ? "confirmEnableEndpoint"
                    : "confirmEnableHost",
          { label: dialog.mutation.label },
        )}
      </p>
      <div class="dialog-footer">
        <button data-cancel-mutation @click=${options.onClose}>${copy("cancel")}</button
        ><button class="primary" data-confirm-mutation @click=${options.onApprove}>
          ${copy("confirm")}
        </button>
      </div>
    </section>`;
  }
  if (dialog.kind === "endpoint") {
    const reviewing = Boolean(dialog.probe);
    return html`<form
        data-endpoint-probe
        ?hidden=${workingOrSuccess || reviewing}
        @submit=${options.onSubmit}
      >
        <fieldset ?disabled=${options.busy}>
          <input type="hidden" name="endpointId" .value=${dialog.draft.endpointId ?? ""} /><label
            >${copy("label")}<input
              name="label"
              .value=${dialog.draft.label}
              @input=${options.onInput}
              required
              autofocus /></label
          ><label
            >${copy("endpointHost")}<input
              name="host"
              .value=${dialog.draft.host}
              @input=${options.onInput}
              required /></label
          ><label
            >${copy("port")}<input
              name="port"
              type="number"
              min="1"
              max="65535"
              .value=${String(dialog.draft.port)}
              @input=${options.onInput}
              required /></label
          ><label
            >${copy("adDomain")}<input
              name="adDomain"
              .value=${dialog.draft.adDomain}
              @input=${options.onInput}
              required
          /></label>
          <p class="muted small">${copy("endpointHelp")}</p>
          <div class="dialog-footer">
            <button type="button" data-cancel-probe @click=${options.onClose}>
              ${copy("cancel")}</button
            ><button class="primary">${copy("probeBeforeSave")}</button>
          </div>
        </fieldset>
      </form>
      ${dialog.probe
        ? html`<section class="probe-facts" ?hidden=${workingOrSuccess}>
            <h3>${copy("verifyHostKey")}</h3>
            <p class="muted small">${copy("hostKeyTargetHelp")}</p>
            <dl>
              <dt>${copy("endpointHost")}</dt>
              <dd>${dialog.probe.host}:${dialog.probe.port}</dd>
              <dt>DNS</dt>
              <dd>${dialog.probe.resolvedAddresses.join(", ")}</dd>
              <dt>SSH</dt>
              <dd>${dialog.probe.sshBanner}</dd>
              <dt>${copy("fingerprint")}</dt>
              <dd class="fingerprint">${dialog.probe.fingerprint}</dd>
            </dl>
            <p class="muted small">${copy("keyCommentHelp")}</p>
            <div class="dialog-footer">
              <button data-cancel-probe @click=${options.onClose}>${copy("cancel")}</button
              ><button data-back-to-form @click=${options.onBack}>${copy("edit")}</button
              ><button class="primary" data-approve-probe @click=${options.onApprove}>
                ${copy("approveAndSave")}
              </button>
            </div>
          </section>`
        : nothing}`;
  }
  const environment = dialog.kind === "environment";
  const draft = dialog.draft;
  return html`<form
    data-action=${environment
      ? "update-host-execution-environment"
      : dialog.hostId
        ? "update-host"
        : "hosts"}
    ?hidden=${workingOrSuccess}
    @submit=${options.onSubmit}
  >
    <fieldset ?disabled=${options.busy}>
      ${environment
        ? html`<input type="hidden" name="vmHostId" .value=${dialog.host.id} />${environmentFields(
              draft,
              options.onInput,
            )}`
        : html`<input type="hidden" name="vmHostId" .value=${dialog.hostId ?? ""} /><label
              >${copy("vmLabel")}<input
                name="label"
                .value=${dialog.draft.label}
                @input=${options.onInput}
                required
                autofocus /></label
            ><label
              >${copy("targetAddress")}<input
                name="targetAddress"
                .value=${dialog.draft.targetAddress}
                @input=${options.onInput}
                required /></label
            ><label
              >${copy("endpoint")}<select
                name="endpointId"
                .value=${dialog.draft.endpointId}
                @change=${options.onInput}
                required
              >
                <option value="" ?selected=${!dialog.draft.endpointId} disabled>
                  ${copy("chooseEndpoint")}
                </option>
                ${options.snapshot?.endpoints
                  .filter((endpoint) => endpoint.status === "active")
                  .map(
                    (endpoint) =>
                      html`<option
                        value=${endpoint.id}
                        ?selected=${endpoint.id === dialog.draft.endpointId}
                      >
                        ${endpoint.label}
                      </option>`,
                  )}
              </select></label
            >${!dialog.hostId
              ? html`<details>
                  <summary>${copy("optionalEnvironment")}</summary>
                  <div>${environmentFields(dialog.draft, options.onInput)}</div>
                </details>`
              : nothing}`}
      <div class="dialog-footer">
        <button type="button" data-close-admin @click=${options.onClose}>${copy("cancel")}</button
        ><button class="primary">
          ${copy(environment ? "saveEnvironment" : dialog.hostId ? "saveChanges" : "createHost")}
        </button>
      </div>
    </fieldset>
  </form>`;
}

export function renderVmAdministrationDialog(options: VmAdminDialogViewOptions) {
  const dialog = options.dialog;
  return html`<openclaw-modal-dialog
    class="admin-modal palette"
    data-admin-modal
    .open=${Boolean(dialog && options.dialogVisible)}
    .label=${vmAdminDialogTitle(dialog)}
    ${ref((element) =>
      (element as OpenClawModalDialog | undefined)?.setReturnFocusTarget(options.returnFocus),
    )}
    @modal-cancel=${options.onClose}
  >
    ${dialog
      ? html`<section class="admin-dialog" data-operation-phase=${options.operation.kind}>
          <header class="dialog-heading">
            <div>
              <h2>${vmAdminDialogTitle(dialog)}</h2>
              ${dialog.kind === "environment" ? html`<p>${dialog.host.label}</p>` : nothing}
            </div>
            <button
              class="dialog-close"
              type="button"
              data-close-admin
              aria-label=${copy("close")}
              @click=${options.onClose}
            >
              ×
            </button>
          </header>
          ${renderProgress(options.operation)}${options.operation.kind === "error"
            ? html`<div class="form-error" role="alert" tabindex="-1">
                ${options.operation.error}
                <p class="small">${copy("retryHelp")}</p>
              </div>`
            : nothing}${renderEditor(options, dialog)}
        </section>`
      : nothing}
  </openclaw-modal-dialog>`;
}
