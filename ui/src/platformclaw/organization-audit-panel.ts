import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { renderSettingsSection } from "../components/settings-ui.ts";
import { formatDateTimeMs } from "../lib/format.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import {
  PlatformClawOrganizationApi,
  PlatformClawOrganizationApiError,
  type OrganizationAuditFilters,
  type OrganizationAuditRecord,
} from "./organization-api.ts";
import { organizationErrorMessage } from "./organization-errors.ts";

const knownActions = new Set([
  "scope.created",
  "scope.renamed",
  "scope.archived",
  "scope.membership.set",
  "scope.membership.removed",
  "scope.primary.changed",
  "scope.primary.cleared",
  "organization.join.requested",
  "organization.join.cancelled",
  "organization.join.approved",
  "organization.join.rejected",
]);

function actionLabel(eventType: string): string {
  return knownActions.has(eventType)
    ? t(`platformClaw.organization.audit.action.${eventType}`)
    : t("platformClaw.organization.audit.action.unknown");
}

function targetLabel(record: OrganizationAuditRecord): string {
  if (record.target.type === "scope") {
    return record.target.lineage.map((scope) => scope.name).join(" / ");
  }
  if (record.target.type === "user") {
    return record.target.user.displayName ?? record.target.user.accountId;
  }
  return t("platformClaw.organization.audit.targetUnavailable");
}

function changeLabel(record: OrganizationAuditRecord): string | undefined {
  const before =
    record.change?.beforeName ??
    record.change?.priorScope?.name ??
    (record.change?.priorRole
      ? t(`platformClaw.organization.role.${record.change.priorRole}`)
      : undefined);
  const result =
    record.change?.resultName ??
    record.change?.resultScope?.name ??
    (record.change?.resultRole
      ? t(`platformClaw.organization.role.${record.change.resultRole}`)
      : undefined);
  if (!before && !result) {
    return undefined;
  }
  return `${before ?? t("platformClaw.organization.audit.none")} → ${result ?? t("platformClaw.organization.audit.none")}`;
}

function mergeAudit(
  current: OrganizationAuditRecord[],
  incoming: OrganizationAuditRecord[],
): OrganizationAuditRecord[] {
  const items = new Map(current.map((item) => [item.key, item]));
  for (const item of incoming) {
    items.set(item.key, item);
  }
  return [...items.values()];
}

class PlatformClawOrganizationAuditPanel extends OpenClawLightDomElement {
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => {};
  @property({ attribute: false }) onAuthorizationLost: () => void = () => {};
  @state() private items: OrganizationAuditRecord[] = [];
  @state() private nextCursor: string | undefined;
  @state() private filters: OrganizationAuditFilters = {};
  @state() private loading = true;
  @state() private busy = false;
  @state() private error = "";
  private epoch = 0;

  private get api() {
    return new PlatformClawOrganizationApi({
      fetchImpl: this.fetchImpl,
      onUnauthenticated: this.onUnauthenticated,
    });
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.reload());
  }

  private reload(): void {
    const epoch = ++this.epoch;
    this.loading = true;
    this.error = "";
    void this.api
      .audit(undefined, this.filters)
      .then((page) => {
        if (epoch === this.epoch) {
          this.items = page.items;
          this.nextCursor = page.nextCursor;
        }
      })
      .catch((error: unknown) => {
        if (epoch === this.epoch) {
          this.items = [];
          this.nextCursor = undefined;
          this.error = organizationErrorMessage(error, false);
          if (error instanceof PlatformClawOrganizationApiError && error.status === 403) {
            this.onAuthorizationLost();
          }
        }
      })
      .finally(() => {
        if (epoch === this.epoch) {
          this.loading = false;
        }
      });
  }

  private loadMore(): void {
    if (this.busy || this.nextCursor === undefined) {
      return;
    }
    const epoch = this.epoch;
    const cursor = this.nextCursor;
    this.busy = true;
    void this.api
      .audit(cursor, this.filters)
      .then((page) => {
        if (epoch === this.epoch) {
          this.items = mergeAudit(this.items, page.items);
          this.nextCursor = page.nextCursor;
          this.error = "";
        }
      })
      .catch((error: unknown) => {
        if (epoch === this.epoch) {
          this.error = organizationErrorMessage(error, false);
          if (error instanceof PlatformClawOrganizationApiError && error.status === 403) {
            this.items = [];
            this.nextCursor = undefined;
            this.onAuthorizationLost();
          }
        }
      })
      .finally(() => {
        if (epoch === this.epoch) {
          this.busy = false;
        }
      });
  }

  override render() {
    if (this.loading) {
      return html`<p role="status">${t("platformClaw.organization.audit.loading")}</p>`;
    }
    return html`${this.error
      ? html`<div class="callout danger" role="alert">
          ${this.error}
          <button
            class="btn"
            type="button"
            @click=${() => {
              if (this.items.length > 0 && this.nextCursor !== undefined) {
                this.loadMore();
              } else {
                this.reload();
              }
            }}
          >
            ${t("platformClaw.organization.audit.retry")}
          </button>
        </div>`
      : nothing}
    ${renderSettingsSection(
      {
        title: t("platformClaw.organization.audit.title"),
        description: t("platformClaw.organization.audit.description"),
        count: this.items.length,
      },
      html`<form
          class="organization-audit-filters"
          @change=${(event: Event) => {
            const form = event.currentTarget as HTMLFormElement;
            const data = new FormData(form);
            const category = data.get("category");
            const outcome = data.get("outcome");
            this.filters = {
              category:
                typeof category === "string" && category
                  ? (category as OrganizationAuditFilters["category"])
                  : undefined,
              outcome:
                typeof outcome === "string" && outcome
                  ? (outcome as OrganizationAuditFilters["outcome"])
                  : undefined,
            };
            this.reload();
          }}
        >
          <label>
            <span>${t("platformClaw.organization.audit.category")}</span>
            <select name="category" ?disabled=${this.busy}>
              <option value="">${t("platformClaw.organization.audit.filter.all")}</option>
              ${(["scope", "membership", "primary", "join", "other"] as const).map(
                (category) => html`<option
                  value=${category}
                  ?selected=${this.filters.category === category}
                >
                  ${t(`platformClaw.organization.audit.category.${category}`)}
                </option>`,
              )}
            </select>
          </label>
          <label>
            <span>${t("platformClaw.organization.audit.outcome")}</span>
            <select name="outcome" ?disabled=${this.busy}>
              <option value="">${t("platformClaw.organization.audit.filter.all")}</option>
              <option value="succeeded" ?selected=${this.filters.outcome === "succeeded"}>
                ${t("platformClaw.organization.audit.outcome.succeeded")}
              </option>
              <option value="denied" ?selected=${this.filters.outcome === "denied"}>
                ${t("platformClaw.organization.audit.outcome.denied")}
              </option>
            </select>
          </label>
        </form>
        ${this.items.length === 0 && !this.error
          ? html`<p class="muted">${t("platformClaw.organization.audit.empty")}</p>`
          : this.items.length > 0
            ? html`<ol class="organization-audit-list">
                ${this.items.map(
                  (item) => html`<li>
                    <details>
                      <summary>
                        <span>
                          <strong>${actionLabel(item.action)}</strong>
                          <span class="muted">${targetLabel(item)}</span>
                          <span class="organization-audit-outcome">
                            ${item.outcome
                              ? t(`platformClaw.organization.audit.outcome.${item.outcome}`)
                              : t("platformClaw.organization.audit.outcome.recorded")}
                          </span>
                        </span>
                        <time datetime=${new Date(item.occurredAt).toISOString()}
                          >${formatDateTimeMs(item.occurredAt)}</time
                        >
                      </summary>
                      <dl class="organization-audit-details">
                        <div>
                          <dt>${t("platformClaw.organization.audit.actor")}</dt>
                          <dd>
                            ${item.actor?.displayName ??
                            item.actor?.accountId ??
                            t("platformClaw.organization.audit.system")}
                          </dd>
                        </div>
                        ${item.subject
                          ? html`<div>
                              <dt>${t("platformClaw.organization.audit.subject")}</dt>
                              <dd>${item.subject.displayName ?? item.subject.accountId}</dd>
                            </div>`
                          : nothing}
                        <div>
                          <dt>${t("platformClaw.organization.audit.target")}</dt>
                          <dd>${targetLabel(item)}</dd>
                        </div>
                        <div>
                          <dt>${t("platformClaw.organization.audit.outcome")}</dt>
                          <dd>
                            ${item.outcome
                              ? t(`platformClaw.organization.audit.outcome.${item.outcome}`)
                              : t("platformClaw.organization.audit.outcome.recorded")}
                          </dd>
                        </div>
                        ${item.reason
                          ? html`<div>
                              <dt>${t("platformClaw.organization.audit.reason")}</dt>
                              <dd>${item.reason}</dd>
                            </div>`
                          : nothing}
                        ${changeLabel(item)
                          ? html`<div>
                              <dt>${t("platformClaw.organization.audit.change")}</dt>
                              <dd>${changeLabel(item)}</dd>
                            </div>`
                          : nothing}
                      </dl>
                    </details>
                  </li>`,
                )}
              </ol>`
            : nothing}`,
    )}
    ${this.nextCursor === undefined
      ? nothing
      : html`<button
          class="btn"
          type="button"
          ?disabled=${this.busy}
          @click=${() => this.loadMore()}
        >
          ${t("platformClaw.organization.audit.more")}
        </button>`}`;
  }
}

if (!customElements.get("platformclaw-organization-audit-panel")) {
  customElements.define(
    "platformclaw-organization-audit-panel",
    PlatformClawOrganizationAuditPanel,
  );
}
