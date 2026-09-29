import { html, nothing } from "lit";
import type { KnowledgeVaultCatalogEntry } from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../pages/config/memory-memories.ts";
import { renderHubTabs } from "../components/hub-tabs.ts";
import { icons } from "../components/icons.ts";
import "../components/modal-dialog.ts";
import { renderSettingsToggle } from "../components/settings-ui.ts";
import { platformClawT } from "./i18n.ts";

const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);
export type VaultCatalogTab = "mine" | "discover" | "requests";

export function renderVaultCatalog(options: {
  vaults: KnowledgeVaultCatalogEntry[];
  tab: VaultCatalogTab;
  query: string;
  busy: boolean;
  requestCount: number;
  requestsContent: unknown;
  pendingVaultIds: ReadonlySet<string>;
  onTab: (tab: VaultCatalogTab) => void;
  onQuery: (query: string) => void;
  onOpen: (vault: KnowledgeVaultCatalogEntry) => void;
  onConnection: (vault: KnowledgeVaultCatalogEntry) => void;
  onRequest: (vault: KnowledgeVaultCatalogEntry) => void;
  onRecover: (vault: KnowledgeVaultCatalogEntry) => void;
  onCreate: () => void;
  onImport: () => void;
}) {
  const query = options.query.trim().toLocaleLowerCase();
  const accessible = options.vaults.filter((vault) => vault.canRead);
  const shared = options.vaults.filter((vault) => vault.type === "shared");
  const visible = (options.tab === "mine" ? accessible : shared).filter((vault) =>
    `${vault.name} ${vault.description}`.toLocaleLowerCase().includes(query),
  );
  return html`<header class="vaults__heading">
      <div>
        <h2>${t("title")}</h2>
        <p>${t("catalogHint")}</p>
      </div>
      <div class="vaults__actions">
        <button class="btn btn--sm" ?disabled=${options.busy} @click=${options.onImport}>
          ${t("import")}
        </button>
        <button class="btn primary btn--sm" ?disabled=${options.busy} @click=${options.onCreate}>
          ${icons.plus}${t("new")}
        </button>
      </div>
    </header>
    ${renderHubTabs<VaultCatalogTab>({
      id: "vault-catalog",
      active: options.tab,
      variant: "sub",
      tabs: [
        { value: "mine", label: t("mine"), count: accessible.length },
        { value: "discover", label: t("discover"), count: shared.length },
        { value: "requests", label: t("requests"), count: options.requestCount },
      ],
      ariaLabel: t("catalogTabs"),
      panelId: "vault-catalog-panel",
      onSelect: options.onTab,
    })}
    <section
      id="vault-catalog-panel"
      role="tabpanel"
      aria-labelledby=${`vault-catalog-tab-${options.tab}`}
    >
      ${options.tab === "requests"
        ? options.requestsContent
        : html`
            <div class="vaults__catalog-search">
              ${icons.search}<input
                class="settings-input"
                type="search"
                aria-label=${t("findLabel")}
                placeholder=${t("findPlaceholder")}
                .value=${options.query}
                @input=${(event: Event) =>
                  options.onQuery((event.target as HTMLInputElement).value)}
              />
            </div>
            <p class="vaults__hint">
              ${t(options.tab === "mine" ? "nextTurnHint" : "discoverHint")}
            </p>
            <div class="vaults__grid">
              ${visible.map(
                (vault) => html`<article class="vaults__card" data-vault-card=${vault.id}>
                  <div class="vaults__card-top">
                    ${vault.role
                      ? html`<span class="vaults__badge" data-vault-role=${vault.role}
                          >${t(vault.role)}</span
                        >`
                      : html`<span class="vaults__hint">${t("noAccess")}</span>`}
                    ${vault.canRead
                      ? html`<label class="vaults__enable"
                          ><span>${t("aiReference")}</span>${renderSettingsToggle({
                            checked: vault.connected,
                            disabled: options.busy,
                            ariaLabel: `${vault.name}: ${t("aiReference")}`,
                            onChange: () => {
                              options.onConnection(vault);
                              return false;
                            },
                          })}</label
                        >`
                      : nothing}
                  </div>
                  ${vault.canRead
                    ? html`<button
                        class="vaults__card-title"
                        ?disabled=${options.busy}
                        @click=${() => options.onOpen(vault)}
                      >
                        ${vault.name}
                      </button>`
                    : html`<h3 class="vaults__card-title">${vault.name}</h3>`}
                  <p>
                    ${vault.description ||
                    t(vault.type === "personal" ? "personalHint" : "sharedHint")}
                  </p>
                  ${vault.connectionIssue === "capacity"
                    ? html`<p class="vaults__hint" role="status">${t("connectionCapacity")}</p>`
                    : nothing}
                  <div class="vaults__card-footer">
                    <span
                      >${vault.type === "personal"
                        ? t("privateLabel")
                        : vault.canRead && vault.documentCount !== undefined
                          ? t("documentCount").replace("{count}", String(vault.documentCount))
                          : t("accessRequired")}</span
                    >
                    ${vault.canRead
                      ? html`<button
                          class="btn btn--sm"
                          ?disabled=${options.busy}
                          @click=${() => options.onOpen(vault)}
                        >
                          ${t("view")}
                        </button>`
                      : html`<button
                          class="btn btn--sm primary"
                          ?disabled=${options.busy || options.pendingVaultIds.has(vault.id)}
                          @click=${() => options.onRequest(vault)}
                        >
                          ${t(
                            options.pendingVaultIds.has(vault.id)
                              ? "requestPending"
                              : "requestAccess",
                          )}
                        </button>`}
                    ${vault.canRecoverOwner
                      ? html`<button
                          class="btn btn--sm"
                          ?disabled=${options.busy}
                          @click=${() => options.onRecover(vault)}
                        >
                          ${t("recoverOwner")}
                        </button>`
                      : nothing}
                  </div>
                </article>`,
              )}
            </div>
            ${visible.length ? nothing : html`<p class="vaults__empty">${t("noMatches")}</p>`}
          `}
    </section>`;
}

export function renderVaultDialog(options: {
  title: string;
  content: unknown;
  busy: boolean;
  error: string;
  onClose: () => boolean | void;
}) {
  return html`<openclaw-modal-dialog
    class="vaults__modal"
    label=${options.title}
    @modal-cancel=${(event: Event) => {
      if (options.busy) {
        event.preventDefault();
      } else if (options.onClose() === false) {
        event.preventDefault();
      }
    }}
  >
    <section class="vaults__dialog">
      <header class="vaults__heading">
        <h2>${options.title}</h2>
        <button
          type="button"
          class="btn btn--sm"
          aria-label=${t("closeDialog")}
          ?disabled=${options.busy}
          @click=${options.onClose}
        >
          ${icons.x}
        </button>
      </header>
      ${options.error ? html`<p class="callout danger" role="alert">${options.error}</p>` : nothing}
      ${options.content}
    </section>
  </openclaw-modal-dialog>`;
}

export function renderVaultSearch(options: {
  client: GatewayBrowserClient | null;
  connected: boolean;
  methods: readonly string[];
  agentId: string | null;
  scope: "connected" | "all" | "selected";
  vaultId: string | null;
  revision: number;
  onOpen: (vaultId: string, documentId: string) => void;
  onScope: (scope: "connected" | "all" | "selected") => void;
}) {
  return html`<details class="vaults__search-panel" ?open=${Boolean(options.vaultId)}>
    <summary>${t("searchDocuments")}</summary>
    ${renderHubTabs({
      id: "vault-search",
      active: options.scope,
      variant: "sub",
      ariaLabel: t("searchScope"),
      panelId: "vault-search-panel",
      tabs: [
        { value: "connected" as const, label: t("connectedScope") },
        { value: "all" as const, label: t("allVaults") },
        ...(options.vaultId ? [{ value: "selected" as const, label: t("searchThisVault") }] : []),
      ],
      onSelect: options.onScope,
    })}
    <div
      id="vault-search-panel"
      role="tabpanel"
      aria-labelledby=${`vault-search-tab-${options.scope}`}
    >
      <openclaw-memory-memories
        .documentDialogs=${true}
        .client=${options.client}
        .connected=${options.connected}
        .methodAdvertised=${options.methods.includes("memory.search")}
        .unifiedSearch=${true}
        .compactSearch=${true}
        .searchPlaceholder=${t(
          options.scope === "selected" ? "searchWithinVault" : "searchDocuments",
        )}
        .vaultGetAdvertised=${options.methods.includes("platformclaw.vault.document.get")}
        .wikiGetAdvertised=${options.methods.includes("wiki.document.get")}
        .personalDetailAdvertised=${options.methods.includes("agents.workspace.get")}
        .agentId=${options.agentId}
        .searchScope=${options.scope === "all" ? "all" : "connected"}
        .refreshRevision=${options.revision}
        .vaultId=${options.scope === "selected" ? options.vaultId : null}
        .translator=${platformClawT}
        .openVaultDocument=${options.onOpen}
      ></openclaw-memory-memories>
    </div>
  </details>`;
}
