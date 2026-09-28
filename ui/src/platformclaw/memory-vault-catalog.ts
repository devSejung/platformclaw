import { html, nothing } from "lit";
import type { KnowledgeVaultCatalogEntry } from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../pages/config/memory-memories.ts";
import { renderHubTabs } from "../components/hub-tabs.ts";
import "../components/modal-dialog.ts";
import { icons } from "../components/icons.ts";
import { platformClawT } from "./i18n.ts";

const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);
export type VaultCatalogTab = "mine" | "discover";

export function renderVaultCatalog(options: {
  vaults: KnowledgeVaultCatalogEntry[];
  tab: VaultCatalogTab;
  query: string;
  busy: boolean;
  onTab: (tab: VaultCatalogTab) => void;
  onQuery: (query: string) => void;
  onOpen: (vault: KnowledgeVaultCatalogEntry) => void;
  onConnection: (vault: KnowledgeVaultCatalogEntry) => void;
  onPersonal: () => void;
  onCreate: () => void;
  onImport: () => void;
}) {
  const query = options.query.trim().toLocaleLowerCase();
  const visible = options.vaults.filter(
    (vault) =>
      (options.tab === "discover" || vault.connected) &&
      `${vault.name} ${vault.description}`.toLocaleLowerCase().includes(query),
  );
  const showPersonal =
    options.tab === "mine" &&
    `${t("personalTitle")} Personal Wiki`.toLocaleLowerCase().includes(query);
  return html` <header class="vaults__heading">
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
        {
          value: "mine",
          label: t("mine"),
          count: options.vaults.filter((vault) => vault.connected).length + 1,
        },
        { value: "discover", label: t("discover"), count: options.vaults.length },
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
      <div class="vaults__catalog-search">
        ${icons.search}
        <input
          class="settings-input"
          type="search"
          aria-label=${t("findLabel")}
          placeholder=${t("findPlaceholder")}
          .value=${options.query}
          @input=${(event: Event) => options.onQuery((event.target as HTMLInputElement).value)}
        />
      </div>
      <p class="vaults__hint">
        ${options.tab === "mine" ? t("nextTurnHint") : t("accessibleHint")}
      </p>
      <div class="vaults__grid">
        ${showPersonal
          ? html`<article class="vaults__card vaults__card--personal" data-vault-card="personal">
              <div class="vaults__card-top">
                <span class="vaults__type">Personal</span
                ><span class="vaults__badge is-active">${t("alwaysOn")}</span>
              </div>
              <button
                class="vaults__card-title"
                ?disabled=${options.busy}
                @click=${options.onPersonal}
              >
                ${t("personalTitle")}
              </button>
              <p>${t("personalHint")}</p>
              <div class="vaults__card-footer">
                <span>${t("privateLabel")}</span
                ><button class="btn btn--sm" ?disabled=${options.busy} @click=${options.onPersonal}>
                  ${t("openPersonal")}
                </button>
              </div>
            </article>`
          : nothing}
        ${visible.map(
          (vault) => html`<article class="vaults__card" data-vault-card=${vault.id}>
            <div class="vaults__card-top">
              <span class="vaults__type">${vault.type === "managed" ? "Managed" : "Shared"}</span>
              <span class=${`vaults__badge ${vault.connected ? "is-active" : ""}`}
                >${vault.connected ? t("aiOn") : t("notConnected")}</span
              >
            </div>
            <button
              class="vaults__card-title"
              ?disabled=${options.busy}
              @click=${() => options.onOpen(vault)}
            >
              ${vault.name}
            </button>
            <p>
              ${vault.description || (vault.type === "managed" ? t("managed") : t("sharedHint"))}
            </p>
            <div class="vaults__card-meta">
              <span>${t(vault.role ?? "reader")}</span
              ><span>${t("documentCount").replace("{count}", String(vault.documentCount))}</span>
            </div>
            <div class="vaults__card-footer">
              <button
                class="btn btn--sm"
                ?disabled=${options.busy}
                @click=${() => options.onOpen(vault)}
              >
                ${t("view")}
              </button>
              <button
                class=${`btn btn--sm ${vault.connected ? "" : "primary"}`}
                ?disabled=${options.busy}
                @click=${() => options.onConnection(vault)}
              >
                ${vault.connected ? t("disconnect") : t("connect")}
              </button>
            </div>
          </article>`,
        )}
      </div>
      ${!visible.length && (!query || !showPersonal)
        ? html`<div class="vaults__empty">
            <p>
              ${query ? t("noMatches") : options.tab === "mine" ? t("noConnected") : t("empty")}
            </p>
            ${options.tab === "mine"
              ? html`<button class="btn" @click=${() => options.onTab("discover")}>
                  ${t("discover")}
                </button>`
              : nothing}
          </div>`
        : nothing}
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
        .organizationGetAdvertised=${options.methods.includes("platformclaw.memory.get")}
        .personalDetailAdvertised=${options.methods.includes("agents.workspace.get")}
        .agentId=${options.agentId}
        .searchScope=${options.scope === "all" ? "all" : "connected"}
        .refreshRevision=${options.revision}
        .vaultId=${options.scope === "selected" ? options.vaultId : null}
        .translator=${platformClawT}
        .openSharedDocument=${options.onOpen}
      ></openclaw-memory-memories>
    </div>
  </details>`;
}
