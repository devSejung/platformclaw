import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { platformClawT as t } from "./i18n.ts";

export type McpCredentialMode = "none" | "shared" | "personal";
export type McpHeaderGuide = { name: string; description?: string };
export type McpSecretDraft =
  | { kind: "stored" }
  | { kind: "editing"; value: string }
  | { kind: "deleted" };
export type McpCatalogRow = {
  id: string;
  name: string;
  origin: "organization";
  credentialMode: McpCredentialMode;
  enabled: boolean;
  globalEnabled: boolean;
  configured: boolean;
};
export type McpCatalogSelection = {
  search: string;
  policy: "all" | McpCredentialMode;
  status: "all" | "enabled" | "disabled" | "needs";
  page: number;
  selected: string | null;
  picking: boolean;
};

export function createMcpCatalogSelection(): McpCatalogSelection {
  return { search: "", policy: "all", status: "all", page: 0, selected: null, picking: false };
}

function mcpPolicyLabel(mode: McpCredentialMode): string {
  return t(
    `platformClaw.mcp.${mode === "none" ? "adminNoCredentialShort" : mode === "shared" ? "adminSharedCredential" : "adminPersonalCredential"}`,
  );
}

export function selectMcpCatalogPage(rows: McpCatalogRow[], selection: McpCatalogSelection) {
  const query = selection.search.trim().toLocaleLowerCase();
  const filtered = rows.filter(
    (row) =>
      (!query || row.name.toLocaleLowerCase().includes(query)) &&
      (selection.policy === "all" || row.credentialMode === selection.policy) &&
      (selection.status === "all" ||
        (selection.status === "enabled"
          ? row.enabled
          : selection.status === "disabled"
            ? !row.enabled
            : row.globalEnabled && row.credentialMode === "personal" && !row.configured)),
  );
  const page = Math.min(selection.page, Math.max(0, Math.ceil(filtered.length / 6) - 1));
  const start = page * 6;
  const visible = filtered.slice(start, start + 6);
  return { filtered, visible, page, start };
}

export function renderMcpWorkspace(options: {
  rows: McpCatalogRow[];
  selection: McpCatalogSelection;
  admin: boolean;
  busy: boolean;
  loading: boolean;
  detail: TemplateResult;
  onSelect(id: string): void;
  onToggle(id: string, enabled: boolean): void;
  onFilter(patch: Partial<McpCatalogSelection>): void;
}) {
  const { selection } = options;
  const { filtered, visible, page, start } = selectMcpCatalogPage(options.rows, selection);
  const selected = options.rows.find((row) => row.id === selection.selected);
  const filter = (patch: Partial<McpCatalogSelection>) => options.onFilter({ ...patch, page: 0 });
  return html` <div class="mobile-picker">
      <button
        type="button"
        data-action="picker"
        @click=${() => options.onFilter({ picking: !selection.picking })}
      >
        ${selection.picking
          ? t("platformClaw.mcp.showSettings")
          : t("platformClaw.mcp.changeServer", {
              server: selected?.name ?? t("platformClaw.mcp.selectServer"),
            })}
      </button>
    </div>
    <div class="workspace" ?data-picking=${selection.picking}>
      <section class="catalog" aria-label=${t("platformClaw.mcp.serverList")}>
        <div class="toolbar">
          <label class="search"
            >${t("platformClaw.mcp.searchServers")}
            <input
              name="search"
              type="search"
              maxlength="128"
              .value=${selection.search}
              @input=${(event: Event) =>
                filter({ search: (event.target as HTMLInputElement).value })}
            />
          </label>
          <label
            >${t("platformClaw.mcp.adminCredentialMode")}
            <select
              name="policyFilter"
              .value=${selection.policy}
              @change=${(event: Event) =>
                filter({
                  policy: (event.target as HTMLSelectElement)
                    .value as McpCatalogSelection["policy"],
                })}
            >
              <option value="all">${t("platformClaw.mcp.all")}</option>
              ${(["none", "shared", "personal"] as const).map(
                (mode) => html`<option value=${mode}>${mcpPolicyLabel(mode)}</option>`,
              )}
            </select>
          </label>
          <label
            >${t("platformClaw.mcp.useStatus")}
            <select
              name="statusFilter"
              .value=${selection.status}
              @change=${(event: Event) =>
                filter({
                  status: (event.target as HTMLSelectElement)
                    .value as McpCatalogSelection["status"],
                })}
            >
              <option value="all">${t("platformClaw.mcp.all")}</option>
              <option value="enabled">${t("common.enabled")}</option>
              <option value="disabled">${t("common.disabled")}</option>
              ${options.admin
                ? nothing
                : html`<option value="needs">${t("platformClaw.mcp.credentialNeeded")}</option>`}
            </select>
          </label>
        </div>
        <div class="list-meta">
          <span
            >${t(
              options.admin
                ? "platformClaw.mcp.toggleOrganization"
                : "platformClaw.mcp.togglePersonal",
            )}</span
          ><span>${t("platformClaw.mcp.serverCount", { count: String(filtered.length) })}</span>
        </div>
        <div class="server-list" aria-busy=${String(options.loading)}>
          ${options.loading
            ? html`<p class="empty">${t("common.loading")}</p>`
            : visible.length
              ? visible.map(
                  (row) => html` <article
                    class="server-row"
                    ?data-selected=${selection.selected === row.id}
                  >
                    <button
                      class="server-select"
                      type="button"
                      data-server=${row.name}
                      data-action="select"
                      aria-pressed=${String(selection.selected === row.id)}
                      @click=${() => options.onSelect(row.id)}
                    >
                      <span class="server-name"
                        ><strong>${row.name}</strong
                        ><span class="origin"
                          >${t("platformClaw.mcp.organizationServer")}</span
                        ></span
                      >
                      <span class="policy">${mcpPolicyLabel(row.credentialMode)}</span>
                      ${options.admin
                        ? nothing
                        : html`<span
                            class="status"
                            ?data-warning=${row.globalEnabled &&
                            row.credentialMode === "personal" &&
                            !row.configured}
                            >${!row.globalEnabled
                              ? t("platformClaw.mcp.disabledByAdmin")
                              : row.credentialMode === "shared"
                                ? t("platformClaw.mcp.sharedApplied")
                                : row.credentialMode === "none"
                                  ? t("platformClaw.mcp.noPersonalCredential")
                                  : t(
                                      row.configured
                                        ? "platformClaw.mcp.credentialStored"
                                        : "platformClaw.mcp.credentialNeeded",
                                    )}</span
                          >`}
                    </button>
                    <label class="toggle"
                      ><input
                        type="checkbox"
                        role="switch"
                        data-toggle=${row.name}
                        aria-label=${t(
                          options.admin
                            ? "platformClaw.mcp.organizationToggleLabel"
                            : "platformClaw.mcp.personalToggleLabel",
                          { server: row.name },
                        )}
                        .checked=${live(row.enabled)}
                        ?disabled=${options.busy || (!options.admin && !row.globalEnabled)}
                        @change=${(event: Event) =>
                          options.onToggle(row.id, (event.target as HTMLInputElement).checked)}
                      />
                      <span>${t(row.enabled ? "common.enabled" : "common.disabled")}</span></label
                    >
                  </article>`,
                )
              : html`<p class="empty">${t("platformClaw.mcp.noMatchingServers")}</p>`}
        </div>
        ${filtered.length > 6
          ? html`<nav class="pagination" aria-label=${t("platformClaw.mcp.serverPages")}>
              <span
                >${t("platformClaw.mcp.pageRange", {
                  start: String(start + 1),
                  end: String(start + visible.length),
                  total: String(filtered.length),
                })}</span
              >
              <button
                type="button"
                data-action="previous"
                ?disabled=${page === 0}
                @click=${() => options.onFilter({ page: page - 1, selected: null })}
              >
                ${t("platformClaw.mcp.previousPage")}
              </button>
              <button
                type="button"
                data-action="next"
                ?disabled=${start + 6 >= filtered.length}
                @click=${() => options.onFilter({ page: page + 1, selected: null })}
              >
                ${t("platformClaw.mcp.nextPage")}
              </button>
            </nav>`
          : nothing}
      </section>
      <section class="detail" aria-label=${t("platformClaw.mcp.serverSettings")}>
        ${options.detail}
      </section>
    </div>`;
}
