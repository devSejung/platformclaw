import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { renderModalDialog } from "../components/modal-dialog.ts";
import { renderSettingsEmpty, renderSettingsStatus } from "../components/settings-ui.ts";
import "../components/web-awesome-tabs.ts";
import { i18n } from "../i18n/index.ts";
import {
  selectCredentialCatalogPage,
  type CredentialCatalogRow,
  type CredentialDefinition,
  type CredentialDraft,
  type CredentialSelection,
  type PersonalCredentialDefinition,
} from "./exec-credentials-model.ts";
import { platformClawT as t } from "./i18n.ts";

type CredentialWorkspaceOptions = {
  admin: boolean;
  tab: "personal" | "administration";
  definitions: PersonalCredentialDefinition[];
  adminDefinitions: CredentialDefinition[];
  selection: CredentialSelection;
  blocked: boolean;
  inputBlocked: boolean;
  loading: boolean;
  busy: string;
  pendingEnv: string | undefined;
  message: string;
  flow: TemplateResult | typeof nothing;
  definitionName: string;
  creating: boolean;
  confirmation: CredentialDefinition | null;
  draft: (envName: string) => CredentialDraft;
  onTab: (tab: "personal" | "administration") => void;
  onSelect: (envName: string) => void;
  onFilter: (patch: Partial<CredentialSelection>) => void;
  onInput: (envName: string, value: string) => void;
  onSave: (envName: string) => void;
  onRemove: (envName: string) => void;
  onReload: (envName: string) => void;
  onRecheck: () => void;
  onCreate: () => void;
  onDefinitionName: (value: string) => void;
  onAddDefinition: () => void;
  onRemoveDefinition: (envName: string) => void;
  onConfirmRemoval: () => void;
  onCancelRemoval: () => void;
  onReloadDefinitions: () => void;
};

function credentialStatus(row: CredentialCatalogRow) {
  return renderSettingsStatus({
    kind:
      row.pending || row.conflict || row.error || row.dirty
        ? "warn"
        : row.configured
          ? "ok"
          : "muted",
    label: t(
      row.pending
        ? "platformClaw.execCredentials.pendingStatus"
        : row.conflict
          ? "platformClaw.execCredentials.conflictStatus"
          : row.error
            ? "platformClaw.execCredentials.saveFailed"
            : row.dirty
              ? "platformClaw.execCredentials.unsaved"
              : row.configured
                ? "platformClaw.execCredentials.configured"
                : "platformClaw.execCredentials.notConfigured",
    ),
  });
}

function renderCredentialEditor(
  item: PersonalCredentialDefinition,
  options: CredentialWorkspaceOptions,
) {
  const draft = options.draft(item.envName);
  const disabled =
    options.inputBlocked || options.busy === item.envName || options.pendingEnv === item.envName;
  return html`<section
    data-editor=${item.envName}
    ?hidden=${options.selection.selected !== item.envName}
  >
    <h3 tabindex="-1">${item.envName}</h3>
    <p class="credential-detail__status">
      ${credentialStatus({
        ...item,
        dirty: Boolean(draft.value),
        conflict: draft.conflict,
        error: Boolean(draft.error),
        pending: options.pendingEnv === item.envName,
      })}
    </p>
    <p class="settings-section__desc">${t("platformClaw.execCredentials.replaceHelp")}</p>
    ${item.updatedAt === undefined
      ? nothing
      : html`<p class="credential-updated">
          ${t("platformClaw.execCredentials.updatedAt", {
            date: new Date(item.updatedAt).toLocaleString(i18n.getLocale()),
          })}
        </p>`}
    <form
      class="platformclaw-credential-form"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        options.onSave(item.envName);
      }}
    >
      <label
        >${t("platformClaw.execCredentials.newValue")}
        <input
          class="settings-input"
          data-value=${item.envName}
          aria-label=${item.envName}
          type="password"
          autocomplete="new-password"
          maxlength="32768"
          required
          placeholder=${item.configured
            ? "••••••••"
            : t("platformClaw.execCredentials.valuePlaceholder")}
          .value=${live(draft.value)}
          ?disabled=${disabled}
          @input=${(event: Event) =>
            options.onInput(item.envName, (event.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <div class="credential-actions">
        <button
          class="btn primary"
          data-action="save"
          data-env=${item.envName}
          ?disabled=${options.blocked || draft.conflict || !draft.value.trim()}
        >
          ${t("platformClaw.execCredentials.save")}
        </button>
        ${item.configured
          ? html`<button
              type="button"
              class="btn danger"
              data-action="remove"
              data-env=${item.envName}
              ?disabled=${options.blocked || draft.conflict}
              @click=${() => options.onRemove(item.envName)}
            >
              ${t("platformClaw.execCredentials.remove")}
            </button>`
          : nothing}
        ${draft.value || draft.conflict
          ? html`<button
              type="button"
              class="btn"
              data-action="reload"
              data-env=${item.envName}
              ?disabled=${options.blocked}
              @click=${() => options.onReload(item.envName)}
            >
              ${t("platformClaw.execCredentials.reload")}
            </button>`
          : nothing}
      </div>
    </form>
    ${draft.error
      ? html`<p class="credential-message callout danger" role="alert">
          ${t(draft.error, { envName: item.envName })}
        </p>`
      : nothing}
    ${draft.message
      ? html`<p class="credential-message callout info" role="status">
          ${t(draft.message, { envName: item.envName })}
        </p>`
      : nothing}
  </section>`;
}

function renderCredentialCatalog(
  rows: CredentialCatalogRow[],
  options: CredentialWorkspaceOptions,
) {
  const administration = options.tab === "administration";
  const { filtered, page, start, visible } = selectCredentialCatalogPage(rows, options.selection);
  return html`<section
    class="credential-catalog"
    aria-label=${t("platformClaw.execCredentials.keyList")}
  >
    <div class="credential-toolbar">
      <label
        >${t("platformClaw.execCredentials.search")}
        <input
          class="settings-input"
          type="search"
          name="credentialSearch"
          maxlength="128"
          .value=${options.selection.search}
          @input=${(event: Event) =>
            options.onFilter({ search: (event.currentTarget as HTMLInputElement).value, page: 0 })}
        />
      </label>
      ${administration
        ? nothing
        : html`<label
            >${t("platformClaw.execCredentials.status")}
            <select
              class="settings-select"
              name="credentialStatus"
              .value=${options.selection.status}
              @change=${(event: Event) =>
                options.onFilter({
                  status: (event.currentTarget as HTMLSelectElement)
                    .value as CredentialSelection["status"],
                  page: 0,
                })}
            >
              <option value="all">${t("platformClaw.execCredentials.all")}</option>
              <option value="saved">${t("platformClaw.execCredentials.configured")}</option>
              <option value="missing">${t("platformClaw.execCredentials.notConfigured")}</option>
              <option value="drafts">${t("platformClaw.execCredentials.unsaved")}</option>
            </select>
          </label>`}
    </div>
    <div class="credential-list-meta">
      <span>${t("platformClaw.execCredentials.keyCount", { count: String(filtered.length) })}</span>
      ${administration
        ? html`<button
            type="button"
            class="btn btn--sm"
            data-action="add-definition"
            ?disabled=${options.blocked}
            @click=${options.onCreate}
          >
            ${t("platformClaw.execCredentials.add")}
          </button>`
        : nothing}
    </div>
    <div class="credential-list" aria-busy=${String(options.loading)}>
      ${visible.length
        ? visible.map(
            (row) => html`<button
              type="button"
              class="credential-list__row"
              data-action="select"
              data-env=${row.envName}
              aria-pressed=${String(
                options.selection.selected === row.envName && !options.creating,
              )}
              @click=${() => options.onSelect(row.envName)}
            >
              <span class="credential-list__name" title=${row.envName}>${row.envName}</span>
              ${administration
                ? html`<span class="credential-list__origin"
                    >${t("platformClaw.execCredentials.organizationAllowed")}</span
                  >`
                : credentialStatus(row)}
            </button>`,
          )
        : renderSettingsEmpty(
            t(options.loading ? "common.loading" : "platformClaw.execCredentials.noMatches"),
          )}
    </div>
    ${filtered.length > 8
      ? html`<nav
          class="credential-pagination"
          aria-label=${t("platformClaw.execCredentials.pages")}
        >
          <span
            >${t("platformClaw.execCredentials.range", {
              start: String(start + 1),
              end: String(start + visible.length),
              total: String(filtered.length),
            })}</span
          >
          <div>
            <button
              type="button"
              class="btn btn--sm"
              data-action="previous"
              ?disabled=${page === 0}
              @click=${() => options.onFilter({ page: page - 1 })}
            >
              ${t("platformClaw.execCredentials.previous")}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              data-action="next"
              ?disabled=${start + 8 >= filtered.length}
              @click=${() => options.onFilter({ page: page + 1 })}
            >
              ${t("platformClaw.execCredentials.next")}
            </button>
          </div>
        </nav>`
      : nothing}
  </section>`;
}

function renderCredentialAdministration(options: CredentialWorkspaceOptions) {
  const selected = options.adminDefinitions.find(
    (item) => item.envName === options.selection.selected,
  );
  return options.creating || !selected
    ? html`<section data-admin-editor>
        <h3>${t("platformClaw.execCredentials.addAllowedKey")}</h3>
        <p class="settings-section__desc">${t("platformClaw.execCredentials.adminIntro")}</p>
        <form
          class="platformclaw-credential-definition-form"
          data-admin-form
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            options.onAddDefinition();
          }}
        >
          <label
            >${t("platformClaw.execCredentials.envName")}<input
              class="settings-input"
              name="envName"
              aria-label=${t("platformClaw.execCredentials.adminTitle")}
              autocomplete="off"
              maxlength="128"
              placeholder="OPENAI_API_KEY"
              required
              .value=${live(options.definitionName)}
              ?disabled=${options.blocked}
              @input=${(event: Event) =>
                options.onDefinitionName((event.currentTarget as HTMLInputElement).value)}
          /></label>
          <button
            class="btn primary"
            ?disabled=${options.blocked || !options.definitionName.trim()}
          >
            ${t("platformClaw.execCredentials.add")}
          </button>
        </form>
      </section>`
    : html`<section data-admin-editor=${selected.envName}>
        <h3>${selected.envName}</h3>
        <p class="settings-section__desc">${t("platformClaw.execCredentials.adminIntro")}</p>
        <div class="callout warning">
          ${t("platformClaw.execCredentials.removeDefinitionImpact", { envName: selected.envName })}
        </div>
        <button
          type="button"
          class="btn danger"
          data-action="remove-definition"
          data-env=${selected.envName}
          ?disabled=${options.blocked}
          @click=${() => options.onRemoveDefinition(selected.envName)}
        >
          ${t("platformClaw.execCredentials.removeAllowedKey")}
        </button>
      </section>`;
}

export function renderCredentialWorkspace(options: CredentialWorkspaceOptions) {
  const administration = options.tab === "administration";
  const rows: CredentialCatalogRow[] = administration
    ? options.adminDefinitions.map((item) => ({
        ...item,
        configured: false,
        dirty: false,
        conflict: false,
        error: false,
      }))
    : options.definitions.map((item) => ({
        ...item,
        dirty: Boolean(options.draft(item.envName).value),
        conflict: options.draft(item.envName).conflict,
        error: Boolean(options.draft(item.envName).error),
        pending: options.pendingEnv === item.envName,
      }));
  const selected = rows.find((row) => row.envName === options.selection.selected);
  const { filtered } = selectCredentialCatalogPage(rows, options.selection);
  return html`
    ${options.flow}
    ${options.admin
      ? html`<wa-tab-group
          class="credential-tabs"
          .active=${options.tab}
          aria-label=${t("platformClaw.execCredentials.pageTitle")}
          without-scroll-controls
          @wa-tab-show=${(event: CustomEvent<{ name: string }>) => {
            if (event.detail.name === "personal" || event.detail.name === "administration") {
              options.onTab(event.detail.name);
            }
          }}
        >
          <wa-tab
            id="credential-tab-personal"
            slot="nav"
            panel="personal"
            ?active=${!administration}
            aria-controls="credential-workspace-panel"
            >${t("platformClaw.execCredentials.myTab")}</wa-tab
          >
          <wa-tab
            id="credential-tab-administration"
            slot="nav"
            panel="administration"
            ?active=${administration}
            aria-controls="credential-workspace-panel"
            >${t("platformClaw.execCredentials.adminTab")}</wa-tab
          >
        </wa-tab-group>`
      : nothing}
    ${options.pendingEnv
      ? html`<div
          class="callout warning credential-pending"
          role="status"
          data-pending-env=${options.pendingEnv}
        >
          <span
            >${t("platformClaw.execCredentials.pendingNamed", {
              envName: options.pendingEnv,
            })}</span
          >
          <button
            type="button"
            class="btn"
            data-recheck
            ?disabled=${options.loading || Boolean(options.busy)}
            @click=${options.onRecheck}
          >
            ${t("platformClaw.credentialFlow.recheckStatus")}
          </button>
        </div>`
      : nothing}
    ${options.message
      ? html`<div class="callout info credential-message" role="status">
          <p>${t(options.message)}</p>
          ${options.admin && administration
            ? html`<button
                type="button"
                class="btn"
                data-action="reload-definitions"
                ?disabled=${options.blocked}
                @click=${options.onReloadDefinitions}
              >
                ${t("platformClaw.execCredentials.reloadDefinitions")}
              </button>`
            : nothing}
        </div>`
      : nothing}
    <section
      id="credential-workspace-panel"
      role=${options.admin ? "tabpanel" : nothing}
      aria-labelledby=${options.admin ? `credential-tab-${options.tab}` : nothing}
    >
      <header class="credential-heading">
        <h2>
          ${t(
            administration
              ? "platformClaw.execCredentials.adminTitle"
              : "platformClaw.execCredentials.title",
          )}
        </h2>
        <p class="settings-section__desc">
          ${t(
            administration
              ? "platformClaw.execCredentials.adminIntro"
              : "platformClaw.execCredentials.intro",
          )}
        </p>
      </header>
      <button
        type="button"
        class="btn credential-picker"
        data-action="picker"
        @click=${() => options.onFilter({ picking: !options.selection.picking })}
      >
        ${t(
          options.selection.picking
            ? "platformClaw.execCredentials.showDetail"
            : "platformClaw.execCredentials.chooseKey",
        )}
      </button>
      <div class="credential-workspace" ?data-picking=${options.selection.picking}>
        ${renderCredentialCatalog(rows, options)}
        <section
          class="credential-detail"
          aria-label=${t("platformClaw.execCredentials.selectedKey")}
        >
          ${selected && !filtered.some((row) => row.envName === selected.envName)
            ? html`<p class="credential-filter-note">
                ${t("platformClaw.execCredentials.outsideFilter")}
              </p>`
            : nothing}
          <div ?hidden=${administration}>
            ${options.definitions.length
              ? repeat(
                  options.definitions,
                  (item) => item.envName,
                  (item) => renderCredentialEditor(item, options),
                )
              : renderSettingsEmpty(
                  t(options.loading ? "common.loading" : "platformClaw.execCredentials.empty"),
                )}
          </div>
          ${options.admin
            ? html`<div ?hidden=${!administration}>${renderCredentialAdministration(options)}</div>`
            : nothing}
        </section>
      </div>
    </section>
    ${options.confirmation
      ? renderModalDialog({
          label: t("platformClaw.execCredentials.removeAllowedKey"),
          className: "credential-confirmation",
          onCancel: (event) => {
            if (options.busy) {
              event.preventDefault();
            } else {
              options.onCancelRemoval();
            }
          },
          content: html`<section class="credential-confirmation__body">
            <h2>${t("platformClaw.execCredentials.removeAllowedKey")}</h2>
            <p>
              ${t("platformClaw.execCredentials.removeDefinitionImpact", {
                envName: options.confirmation.envName,
              })}
            </p>
            ${options.message
              ? html`<p class="callout danger" role="alert">${t(options.message)}</p>
                  <button
                    type="button"
                    class="btn"
                    data-action="reload-definitions"
                    ?disabled=${options.blocked}
                    @click=${options.onReloadDefinitions}
                  >
                    ${t("platformClaw.execCredentials.reloadDefinitions")}
                  </button>`
              : nothing}
            <div class="credential-actions">
              <button
                type="button"
                class="btn"
                ?disabled=${Boolean(options.busy)}
                @click=${options.onCancelRemoval}
              >
                ${t("common.cancel")}</button
              ><button
                type="button"
                class="btn danger"
                data-action="confirm-remove-definition"
                data-env=${options.confirmation.envName}
                ?disabled=${Boolean(options.busy)}
                @click=${options.onConfirmRemoval}
              >
                ${t("platformClaw.execCredentials.removeAllowedKey")}
              </button>
            </div>
          </section>`,
        })
      : nothing}
  `;
}
