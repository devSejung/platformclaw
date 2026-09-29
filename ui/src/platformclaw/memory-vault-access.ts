import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  KnowledgeVaultAccessRequest,
  KnowledgeVaultGrantTarget,
  KnowledgeVaultSnapshot,
  KnowledgeVaultRole,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { platformClawT } from "./i18n.ts";
import { renderMemberTargetSearch } from "./member-target-search.ts";

const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);

export function renderVaultRequests(options: {
  own: KnowledgeVaultAccessRequest[];
  pending: KnowledgeVaultAccessRequest[];
  busy: boolean;
  onCancel: (id: string) => void;
  onDecide: (id: string, decision: "approve" | "reject") => void;
}) {
  const row = (request: KnowledgeVaultAccessRequest, owner: boolean) => html`<article
    class="card vaults__member"
  >
    <div>
      <strong>${request.vaultName}</strong>
      <p>
        ${owner ? `${request.displayName} · ${request.accountId}` : t("myRequest")} ·
        ${t(request.role)}
      </p>
      ${request.reason ? html`<p>${request.reason}</p>` : nothing}
      <p class="muted">${t(`requestStatus.${request.status}`)}</p>
    </div>
    ${owner
      ? html`<div class="vaults__actions">
          <button
            class="btn primary"
            ?disabled=${options.busy}
            @click=${() => options.onDecide(request.id, "approve")}
          >
            ${t("approve")}</button
          ><button
            class="btn"
            ?disabled=${options.busy}
            @click=${() => options.onDecide(request.id, "reject")}
          >
            ${t("reject")}
          </button>
        </div>`
      : request.status === "pending"
        ? html`<button
            class="btn"
            ?disabled=${options.busy}
            @click=${() => options.onCancel(request.id)}
          >
            ${t("cancelRequest")}
          </button>`
        : nothing}
  </article>`;
  return html`<section>
    <h3>${t("pendingApprovals")}</h3>
    ${options.pending.length
      ? options.pending.map((request) => row(request, true))
      : html`<p class="muted">${t("noPendingApprovals")}</p>`}
    <h3>${t("myRequests")}</h3>
    ${options.own.length
      ? options.own.map((request) => row(request, false))
      : html`<p class="muted">${t("noRequests")}</p>`}
  </section>`;
}

export function renderVaultAccessRequestForm(options: {
  vaultName: string;
  busy: boolean;
  onSubmit: (role: string, reason: string) => void;
}) {
  return html`<form
    class="vaults__form"
    @submit=${(event: SubmitEvent) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const role = data.get("role");
      const reason = data.get("reason");
      options.onSubmit(
        typeof role === "string" ? role : "",
        typeof reason === "string" ? reason : "",
      );
    }}
  >
    <p>${options.vaultName}</p>
    <p class="vaults__hint">${t("requestHint")}</p>
    <label
      >${t("role")}<select class="settings-select" name="role">
        <option value="reader">${t("reader")}</option>
        <option value="editor">${t("editor")}</option>
      </select></label
    >
    <label
      >${t("requestReason")}<textarea
        class="settings-input"
        name="reason"
        rows="3"
        maxlength="1000"
      ></textarea>
    </label>
    <button class="btn primary" ?disabled=${options.busy}>${t("sendRequest")}</button>
  </form>`;
}

class PlatformClawVaultAccess extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) selected!: NonNullable<KnowledgeVaultSnapshot["selected"]>;
  @property({ type: Boolean }) busy = false;
  @state() private kind: "user" | "organization" = "user";
  @state() private selectedGrantRole: KnowledgeVaultRole = "reader";
  @state() private targets: KnowledgeVaultGrantTarget[] = [];
  @state() private hasMore = false;
  @state() private searching = false;
  @state() private searched = false;
  @state() private error = "";
  @state() private confirmation: {
    message: string;
    method: string;
    params: Record<string, unknown>;
    danger: boolean;
  } | null = null;
  private epoch = 0;
  protected override updated(changed: PropertyValues) {
    if (changed.has("client") || changed.has("selected")) {
      this.epoch++;
      this.targets = [];
      this.searched = this.searching = false;
      this.confirmation = null;
    }
  }
  override disconnectedCallback() {
    this.epoch++;
    super.disconnectedCallback();
  }
  private async search(query: string) {
    if (!this.client || !this.selected.vault.canManageMembers) {
      return;
    }
    const epoch = ++this.epoch;
    this.searching = true;
    this.error = "";
    try {
      const result = await this.client.request<{
        items: KnowledgeVaultGrantTarget[];
        hasMore: boolean;
      }>("platformclaw.vault.targets.search", {
        vaultId: this.selected.vault.id,
        kind: this.kind,
        query,
      });
      if (epoch === this.epoch) {
        this.targets = result.items;
        this.hasMore = result.hasMore;
        this.searched = true;
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
      }
    } finally {
      if (epoch === this.epoch) {
        this.searching = false;
      }
    }
  }
  private mutate(method: string, params: Record<string, unknown>) {
    this.confirmation = null;
    this.dispatchEvent(
      new CustomEvent("vault-access-mutate", {
        bubbles: true,
        detail: { method, params: { vaultId: this.selected.vault.id, ...params } },
      }),
    );
  }
  private confirmMutation(
    message: string,
    method: string,
    params: Record<string, unknown>,
    danger = false,
  ) {
    this.confirmation = { message, method, params, danger };
  }
  override render() {
    if (!this.selected?.vault.canManageMembers) {
      return nothing;
    }
    const busy = this.busy || this.searching;
    return html`<section class="vaults__form">
      <p class="vaults__hint">${t("grantHint")}</p>
      ${this.confirmation
        ? html`<div class="callout warning vaults__confirmation" role="alert">
            <strong>${t("confirmAccessChange")}</strong>
            <p>${this.confirmation.message}</p>
            <div class="vaults__actions">
              <button
                class=${`btn btn--sm ${this.confirmation.danger ? "danger" : "primary"}`}
                ?disabled=${busy}
                @click=${() => this.mutate(this.confirmation!.method, this.confirmation!.params)}
              >
                ${t("confirmAccessChangeAction")}
              </button>
              <button
                class="btn btn--sm"
                ?disabled=${busy}
                @click=${() => (this.confirmation = null)}
              >
                ${t("cancel")}
              </button>
            </div>
          </div>`
        : nothing}
      <h3>${t("directMembers")}</h3>
      ${this.selected.members.map(
        (member) =>
          html`<div class="vaults__member">
            <div>
              <strong>${member.displayName}</strong>
              <p class="muted">${member.accountId} · ${t(member.role)}</p>
            </div>
            <button
              class="btn btn--sm"
              ?disabled=${busy}
              @click=${() =>
                this.confirmMutation(
                  t("confirmRemoveMember").replace("{name}", member.displayName),
                  "member.remove",
                  { userId: member.userId },
                  true,
                )}
            >
              ${t("removeMember")}
            </button>
          </div>`,
      )}
      <h3>${t("organizationGrants")}</h3>
      ${this.selected.grants.length
        ? this.selected.grants.map(
            (grant) =>
              html`<div class="vaults__member">
                <div>
                  <strong>${grant.scopeName}</strong>
                  <p class="muted">${t(grant.role)}</p>
                </div>
                <button
                  class="btn btn--sm"
                  ?disabled=${busy}
                  @click=${() =>
                    this.confirmMutation(
                      t("confirmRemoveOrganization").replace("{name}", grant.scopeName),
                      "grant.remove",
                      { scopeId: grant.scopeId },
                      true,
                    )}
                >
                  ${t("removeMember")}
                </button>
              </div>`,
          )
        : html`<p class="muted">${t("noOrganizationGrants")}</p>`}
      <h3>${t("setMember")}</h3>
      <div class="vaults__actions">
        <label
          >${t("grantTarget")}<select
            class="settings-select"
            .value=${this.kind}
            ?disabled=${busy}
            @change=${(event: Event) => {
              this.kind = (event.currentTarget as HTMLSelectElement).value as typeof this.kind;
              this.epoch++;
              this.targets = [];
              this.searched = false;
            }}
          >
            <option value="user">${t("person")}</option>
            <option value="organization">${t("organization")}</option>
          </select></label
        >
        <label
          >${t("role")}<select
            class="settings-select"
            .value=${this.selectedGrantRole}
            ?disabled=${busy}
            @change=${(event: Event) => {
              this.selectedGrantRole = (event.currentTarget as HTMLSelectElement)
                .value as KnowledgeVaultRole;
            }}
          >
            ${(["reader", "editor", "owner"] as const).map(
              (role) => html`<option value=${role}>${t(role)}</option>`,
            )}
          </select></label
        >
      </div>
      ${renderMemberTargetSearch({
        label: t(this.kind === "user" ? "searchPeople" : "searchOrganizations"),
        searchLabel: t("searchTargets"),
        moreLabel: t("targetsHasMore"),
        busy,
        hasMore: this.hasMore,
        items: this.targets.map((target) => ({ ...target, action: t("grantAccess") })),
        onSearch: (query) => void this.search(query),
        onSelect: (id) => {
          const target = this.targets.find((item) => item.id === id)!;
          const method = this.kind === "user" ? "member.set" : "grant.set";
          const params = {
            ...(this.kind === "user" ? { accountId: target.accountId } : { scopeId: target.id }),
            role: this.selectedGrantRole,
          };
          if (this.kind === "organization" && this.selectedGrantRole === "owner") {
            this.confirmMutation(
              t("confirmOrganizationOwner").replace("{name}", target.label),
              method,
              params,
            );
            return;
          }
          this.mutate(method, params);
        },
      })}
      ${this.searched && !this.targets.length
        ? html`<p role="status">${t("noMatches")}</p>`
        : nothing}
      ${this.error ? html`<p class="callout danger" role="alert">${this.error}</p>` : nothing}
    </section>`;
  }
}
if (!customElements.get("platformclaw-vault-access")) {
  customElements.define("platformclaw-vault-access", PlatformClawVaultAccess);
}
